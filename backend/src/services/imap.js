import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { prisma } from '../lib/prisma.js';
import { decryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { getAccessToken } from './oauth.js';
import { sanitizeInboundHtml } from './template.js';

const MAX_MESSAGES_PER_SYNC = 100;
const MAX_SOURCE_BYTES = 200 * 1024;
const FIRST_SYNC_DAYS = 7;
const SPAM_NAMES = /^(spam|junk|junk e-?mail|junk mail|bulk|bulk mail|\[gmail\]\/spam|\[google mail\]\/spam|inbox[./]spam|inbox[./]junk)$/i;

async function imapClient(account) {
  const auth = account.authType === 'OAUTH2'
    ? { user: account.imapUser || account.smtpUser, accessToken: await getAccessToken(account) }
    : { user: account.imapUser || account.smtpUser, pass: decryptSecret(account.imapPassEnc || account.smtpPassEnc) };
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort || 993,
    secure: account.imapSecure,
    auth,
    logger: false,
    socketTimeout: 60_000,
    greetingTimeout: 15_000,
    connectionTimeout: 15_000,
    tls: { minVersion: 'TLSv1.2' },
    emitLogs: false,
  });
}

export async function testImap(account) {
  if (!account.imapHost) return { ok: false, skipped: true, error: 'No IMAP server configured' };
  let client;
  try {
    client = await imapClient(account);
    client.on('error', () => {});
    await client.connect();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.authenticationFailed ? 'IMAP authentication failed' : String(err.responseText || err.message).slice(0, 300) };
  } finally {
    if (client) await client.logout().catch(() => {});
  }
}

const normId = (s) => {
  if (!s) return null;
  const t = String(s).trim();
  return t.startsWith('<') ? t : `<${t}>`;
};

function idList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(/\s+/);
  return arr.map(normId).filter(Boolean);
}

export function detectBounce(parsed, fromAddr) {
  const ct = String(parsed.headers.get('content-type')?.value || '');
  const subject = String(parsed.subject || '');
  const fromName = String(parsed.from?.value?.[0]?.name || '');
  const isReport = /multipart\/report/i.test(ct)
    || /mailer-daemon|postmaster|mail-?delivery|bounce/i.test(fromAddr)
    || (/mail delivery (subsystem|system)/i.test(fromName) && /undeliver|deliver(y|ed)? (status|failure|failed)|returned mail|failure notice|not delivered/i.test(subject));
  if (!isReport) return null;
  const parts = (parsed.attachments || []).map((a) => a.content?.toString('utf8').slice(0, 30000) || '');
  const body = `${parsed.text || ''}\n${parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : ''}\n${parts.join('\n')}`;
  // The ORIGINAL message's id (inside the returned headers), not the bounce's own Message-ID.
  const origIds = [...body.matchAll(/^Message-ID:\s*(<[^>\s]+>)/gim)].map((m) => m[1]);
  const status = body.match(/^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im)?.[1] || body.match(/\b([45]\.\d\.\d{1,3})\b/)?.[1] || null;
  const failed = String(parsed.headers.get('x-failed-recipients') || '').split(/[,\s]+/).filter((x) => x.includes('@'));
  const finalRcpt = (body.match(/^(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>]+)/im)?.[1] || failed[0] || '').toLowerCase() || null;
  const hard = status ? status.startsWith('5')
    : /does not exist|doesn't exist|user unknown|no such user|address not found|unknown user|mailbox unavailable|invalid recipient|recipient address rejected|address couldn.t be found|domain .* not found|no mx/i.test(body);
  return { originalMessageIds: origIds, status, finalRecipient: finalRcpt, hard };
}

/** Sync one folder incrementally from the stored UID. */
async function syncFolder(client, account, { path, folder, lastUid, uidValidity: storedValidity }) {
  const out = { processed: 0, replies: 0, bounces: 0, maxUid: lastUid ?? 0, uidValidity: null, more: false };
  const lock = await client.getMailboxLock(path);
  try {
    const mbox = client.mailbox;
    const uidValidity = BigInt(mbox.uidValidity ?? 0);
    out.uidValidity = uidValidity;
    let uids;
    if (lastUid == null || storedValidity == null || BigInt(storedValidity) !== uidValidity) {
      const since = new Date(Date.now() - FIRST_SYNC_DAYS * 86_400_000);
      uids = (await client.search({ since }, { uid: true })) || [];
      out.maxUid = 0;
    } else {
      uids = (await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || [];
      uids = uids.filter((u) => u > lastUid);
    }
    uids.sort((a, b) => a - b);
    const batch = uids.slice(0, MAX_MESSAGES_PER_SYNC);
    if (batch.length) {
      for await (const msg of client.fetch(batch, { uid: true, source: { start: 0, maxLength: MAX_SOURCE_BYTES } }, { uid: true })) {
        out.maxUid = Math.max(out.maxUid, msg.uid);
        out.processed += 1;
        try {
          const r = await handleInbound(account, msg, folder);
          if (r === 'reply') out.replies += 1;
          if (r === 'bounce') out.bounces += 1;
        } catch (err) {
          logger.warn({ accountId: account.id, folder, uid: msg.uid, err: err.message }, 'failed to process inbound message');
        }
      }
    } else if (uids.length === 0 && (lastUid == null || out.maxUid === 0)) {
      out.maxUid = Math.max(0, (mbox.uidNext ?? 1) - 1);
    }
    out.more = uids.length > batch.length;
  } finally {
    lock.release();
  }
  return out;
}

async function findSpamPath(client, account) {
  if (account.imapSpamPath) return account.imapSpamPath;
  const boxes = await client.list();
  const box = boxes.find((b) => b.specialUse === '\\Junk') || boxes.find((b) => SPAM_NAMES.test(b.path));
  return box?.path || null;
}

/** Incremental sync of INBOX and the Spam/Junk folder: detects replies and bounces for campaign recipients. */
export async function syncAccount(account) {
  if (!account.imapHost) return { skipped: true };
  const client = await imapClient(account);
  client.on('error', (err) => logger.warn({ accountId: account.id, err: err.message }, 'imap socket error'));
  const total = { processed: 0, replies: 0, bounces: 0 };
  await client.connect();
  try {
    const inbox = await syncFolder(client, account, { path: 'INBOX', folder: 'INBOX', lastUid: account.imapLastUid, uidValidity: account.imapUidValidity });
    const data = {
      imapUidValidity: inbox.uidValidity, imapLastUid: inbox.maxUid, imapLastSyncAt: new Date(), imapOk: true,
    };
    let more = inbox.more;
    for (const k of Object.keys(total)) total[k] += inbox[k];

    // Replies and bounces sometimes land in Spam / Junk — check it too.
    try {
      const spamPath = await findSpamPath(client, account);
      if (spamPath) {
        const spam = await syncFolder(client, account, { path: spamPath, folder: 'SPAM', lastUid: account.imapSpamLastUid, uidValidity: account.imapSpamUidValidity });
        Object.assign(data, { imapSpamPath: spamPath, imapSpamUidValidity: spam.uidValidity, imapSpamLastUid: spam.maxUid });
        for (const k of Object.keys(total)) total[k] += spam[k];
        more = more || spam.more;
      }
    } catch (err) {
      logger.warn({ accountId: account.id, err: err.message }, 'spam folder sync skipped');
      data.imapSpamPath = null; // re-detect next time
    }
    if (more) data.imapNextSyncAt = new Date(Date.now() + 20_000);
    await prisma.emailAccount.update({ where: { id: account.id }, data });
  } finally {
    await client.logout().catch(() => {});
  }
  return total;
}

const RECIPIENT_SELECT = { id: true, campaignId: true, email: true, repliedAt: true, status: true };

async function findRecipientByRefs(account, refs) {
  if (!refs.length) return null;
  // Amazon SES rewrites Message-IDs to <SES-MessageId@...amazonses.com>; match those by provider id too.
  const sesIds = refs.map((r) => /^<([^@>]+)@(?:[a-z0-9-]+\.)*amazonses\.com>$/i.exec(r)?.[1]).filter(Boolean);
  return prisma.campaignRecipient.findFirst({
    where: {
      OR: [{ messageId: { in: refs } }, ...(sesIds.length ? [{ providerMessageId: { in: sesIds } }] : [])],
      campaign: { ownerId: account.ownerId },
    },
    orderBy: { sentAt: 'desc' },
    select: RECIPIENT_SELECT,
  });
}

async function handleInbound(account, msg, folder = 'INBOX') {
  if (!msg.source) return null;
  const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 150_000 });
  const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
  if (fromAddr && fromAddr === account.email.toLowerCase()) return null; // our own copy
  const messageId = normId(parsed.messageId) || `<uid-${msg.uid}@${account.id}>`;

  const bounce = detectBounce(parsed, fromAddr);
  const headerRefs = [...idList(parsed.inReplyTo), ...idList(parsed.references)];
  let recipient = null;
  if (bounce) {
    recipient = await findRecipientByRefs(account, [...bounce.originalMessageIds, ...headerRefs]);
    // Some servers return no usable Message-ID: fall back to "the address that bounced, recently sent from this mailbox".
    if (!recipient && bounce.finalRecipient) {
      recipient = await prisma.campaignRecipient.findFirst({
        where: {
          email: bounce.finalRecipient, accountId: account.id, sentAt: { gte: new Date(Date.now() - 14 * 86_400_000) },
          status: { in: ['SENT', 'UNKNOWN', 'BOUNCED'] }, campaign: { ownerId: account.ownerId },
        },
        orderBy: { sentAt: 'desc' },
        select: RECIPIENT_SELECT,
      });
    }
  } else {
    recipient = await findRecipientByRefs(account, headerRefs);
  }
  if (!recipient) return null; // Only campaign-related mail is stored (keeps Neon storage small).

  const data = {
    ownerId: account.ownerId,
    accountId: account.id,
    recipientId: recipient.id,
    campaignId: recipient.campaignId,
    direction: 'INBOUND',
    messageId,
    inReplyTo: normId(parsed.inReplyTo),
    references: idList(parsed.references).join(' ') || null,
    fromAddr,
    toAddr: parsed.to?.value?.[0]?.address?.toLowerCase() || account.email,
    subject: parsed.subject?.slice(0, 500) || null,
    text: (parsed.text || '').slice(0, 50_000),
    html: parsed.html ? sanitizeInboundHtml(parsed.html).slice(0, 100_000) : null,
    isBounce: Boolean(bounce),
    folder,
    receivedAt: parsed.date || new Date(),
  };
  const created = await prisma.emailMessage.upsert({
    where: { accountId_messageId: { accountId: account.id, messageId } },
    update: {},
    create: data,
  });

  if (bounce) {
    if (bounce.hard && recipient.status !== 'BOUNCED') {
      await prisma.$transaction([
        prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: 'BOUNCED', bouncedAt: new Date(), lastError: `Bounced ${bounce.status || ''}: ${String(parsed.subject || '').slice(0, 120)}`.trim() } }),
        prisma.suppression.upsert({
          where: { scopeKey_email: { scopeKey: 'global', email: recipient.email } },
          update: {},
          create: { scopeKey: 'global', email: recipient.email, reason: 'HARD_BOUNCE', source: `dsn ${bounce.status || ''}`.trim(), campaignId: recipient.campaignId },
        }),
        prisma.trackingEvent.create({ data: { recipientId: recipient.id, campaignId: recipient.campaignId, type: 'BOUNCE' } }),
      ]);
    }
    return 'bounce';
  }

  if (!recipient.repliedAt && created) {
    await prisma.$transaction([
      prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { repliedAt: data.receivedAt } }),
      prisma.trackingEvent.create({ data: { recipientId: recipient.id, campaignId: recipient.campaignId, type: 'REPLY' } }),
    ]);
  }
  return 'reply';
}

/** Reconciliation: look for our own Message-IDs in the Sent folder to resolve UNKNOWN sends. */
export async function findInSent(account, messageIds) {
  if (!account.imapHost || !messageIds.length) return new Set();
  const client = await imapClient(account);
  client.on('error', () => {});
  const found = new Set();
  await client.connect();
  try {
    const boxes = await client.list();
    const sent = boxes.find((b) => b.specialUse === '\\Sent') || boxes.find((b) => /^(sent|sent items|sent mail|\[gmail\]\/sent mail)$/i.test(b.path));
    if (!sent) return found;
    const lock = await client.getMailboxLock(sent.path);
    try {
      for (const id of messageIds.slice(0, 25)) {
        const res = await client.search({ header: { 'message-id': id } }, { uid: true });
        if (res && res.length) found.add(id);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return found;
}