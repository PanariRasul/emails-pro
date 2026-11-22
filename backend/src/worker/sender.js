import { Prisma } from '@prisma/client';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { invalidateOwner } from '../lib/cache.js';
import { getSettings } from '../services/settings.js';
import { accountLimits, intervalMs } from '../services/limits.js';
import { buildMessage, makeMessageId } from '../services/template.js';
import { classifySmtpError, closeTransport } from '../services/smtp.js';
import { deliver } from '../services/transports.js';
import { loadUser } from '../middleware/auth.js';
import { notify } from '../services/audit.js';
import { QuotaError, nextWindowStart, releaseSend, reserveSend } from './quota.js';


export function backoffMs(attempt) {
  const base = 2 * 60_000 * 4 ** Math.max(0, attempt - 1); // 2m, 8m, 32m, ...
  const capped = Math.min(base, 2 * 3_600_000);
  return Math.round(capped * (0.75 + Math.random() * 0.5));
}

async function pauseCampaign(c, reason) {
  await prisma.campaign.updateMany({ where: { id: c.id, status: 'SENDING' }, data: { status: 'PAUSED', pausedReason: reason } });
  await notify({ userId: c.ownerId, type: 'campaign.paused', title: `Campaign "${c.name}" paused`, body: reason });
  invalidateOwner(c.ownerId);
}

/**
 * STRICT follow-up rule: a follow-up is only ever sent from the mailbox that sent the original email.
 * If that mailbox is removed, disabled or broken, those follow-ups FAIL — they are never sent from another account.
 */
async function failUnavailableFollowUps(c) {
  await prisma.$executeRaw`
    UPDATE "CampaignRecipient" r
    SET "status" = 'FAILED', "holdReason" = 'ORIGINAL_ACCOUNT_UNAVAILABLE', "lockedAt" = NULL, "lockedBy" = NULL,
        "lastError" = 'Not sent: the original sender ' || a."email" || ' is unavailable. Follow-ups are only sent from the account that sent the first email.'
    FROM "EmailAccount" a
    WHERE r."campaignId" = ${c.id} AND r."status" IN ('PENDING', 'ON_HOLD') AND a."id" = r."accountId"
      AND (a."deletedAt" IS NOT NULL OR a."adminDisabled" = true OR a."status"::text IN ('ERROR', 'DISABLED'))`;
}

const SENDABLE_SQL = Prisma.sql`a."deletedAt" IS NULL AND a."adminDisabled" = false AND a."status" = 'CONNECTED'`;
const lastRebalance = new Map();

/**
 * FRESH campaigns with several mailboxes: unsent recipients of a mailbox that became unusable
 * (removed, disabled, auth error, paused) or is blocked by its daily/hourly quota for a while are moved,
 * evenly, to the campaign's other working mailboxes. Recipients already sent / in flight / unknown are never moved.
 * Returns the number of sendable mailboxes.
 */
async function rebalanceFresh(c, now) {
  const ids = c.accountIds?.length ? c.accountIds : [c.accountId].filter(Boolean);
  const accs = await prisma.emailAccount.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, status: true, deletedAt: true, adminDisabled: true, nextSendAt: true } });
  const sendable = accs.filter((a) => !a.deletedAt && !a.adminDisabled && a.status === 'CONNECTED');
  const soon = now.getTime() + 30 * 60_000;
  const ready = sendable.filter((a) => !a.nextSendAt || a.nextSendAt.getTime() <= soon);
  const last = lastRebalance.get(c.id) || 0;
  if (ids.length > 1 && ready.length && now.getTime() - last > 60_000) {
    lastRebalance.set(c.id, now.getTime());
    const readyIds = ready.map((a) => a.id);
    const moved = await prisma.$executeRaw`
      UPDATE "CampaignRecipient" r
         SET "accountId" = (${readyIds}::text[])[((s.rn % ${readyIds.length}) + 1)::int], "nextAttemptAt" = LEAST(r."nextAttemptAt", ${now})
        FROM (SELECT cr.id, row_number() OVER (ORDER BY cr.id) - 1 AS rn
                FROM "CampaignRecipient" cr
               WHERE cr."campaignId" = ${c.id} AND cr."status" = 'PENDING'
                 AND (cr."accountId" IS NULL OR NOT (cr."accountId" = ANY(${readyIds}::text[])))) s
       WHERE r.id = s.id`;
    if (moved) logger.info({ campaignId: c.id, moved, to: readyIds.length }, 'moved recipients to working mailboxes');
  }
  return { sendable: sendable.length, total: ids.length, unavailable: accs.filter((a) => !sendable.includes(a)).map((a) => a.email), paused: accs.some((a) => a.status === 'PAUSED' && !a.deletedAt && !a.adminDisabled) };
}

/** Per-campaign, per-mailbox pacing: { accountId: ISO time of next allowed send }. */
const pacingOf = (c) => (c.accountPacing && typeof c.accountPacing === 'object' ? c.accountPacing : {});

async function claimRecipient(c, now) {
  const pacing = pacingOf(c);
  const blocked = Object.entries(pacing).filter(([, t]) => new Date(t) > now).map(([id]) => id);
  const rows = await prisma.$queryRaw`
    UPDATE "CampaignRecipient" r
    SET "status" = 'SENDING', "lockedAt" = ${now}, "lockedBy" = ${config.instanceId}, "attempts" = r."attempts" + 1,
        "accountId" = COALESCE(r."accountId", ${c.accountId})
    WHERE r."id" = (
      SELECT cr."id" FROM "CampaignRecipient" cr
      JOIN "EmailAccount" a ON a."id" = COALESCE(cr."accountId", ${c.accountId})
      WHERE cr."campaignId" = ${c.id} AND cr."status" = 'PENDING' AND cr."nextAttemptAt" <= ${now}
        AND ${SENDABLE_SQL}
        AND (a."nextSendAt" IS NULL OR a."nextSendAt" <= ${now})
        AND NOT (a."id" = ANY(${blocked}::text[]))
      ORDER BY cr."nextAttemptAt", cr."id"
      LIMIT 1
      FOR UPDATE OF cr SKIP LOCKED
    )
    RETURNING r.*`;
  return rows[0] || null;
}

/** When nothing is claimable right now: wake up when the earliest mailbox/recipient becomes free. */
async function nextWake(c, now) {
  const rows = await prisma.$queryRaw`
    SELECT min(GREATEST(cr."nextAttemptAt", COALESCE(a."nextSendAt", ${now}))) AS t
      FROM "CampaignRecipient" cr JOIN "EmailAccount" a ON a."id" = cr."accountId"
     WHERE cr."campaignId" = ${c.id} AND cr."status" = 'PENDING' AND ${SENDABLE_SQL}`;
  const pacing = Object.values(pacingOf(c)).map((t) => new Date(t)).filter((t) => t > now);
  const candidates = [rows[0]?.t ? new Date(rows[0].t) : null, ...pacing].filter(Boolean).filter((t) => t > now);
  const earliest = candidates.length ? new Date(Math.min(...candidates.map((t) => t.getTime()))) : new Date(now.getTime() + 15_000);
  return new Date(Math.min(Math.max(earliest.getTime(), now.getTime() + 1000), now.getTime() + 5 * 60_000));
}

async function unclaim(r, { nextAttemptAt, countAttempt = false } = {}) {
  await prisma.campaignRecipient.update({
    where: { id: r.id },
    data: {
      status: 'PENDING', lockedAt: null, lockedBy: null,
      ...(countAttempt ? {} : { attempts: { decrement: 1 } }),
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
    },
  });
}

async function maybeComplete(c) {
  const open = await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: { in: ['PENDING', 'SENDING', 'ON_HOLD'] } } });
  if (open === 0) {
    const done = await prisma.campaign.updateMany({ where: { id: c.id, status: 'SENDING' }, data: { status: 'COMPLETED', completedAt: new Date() } });
    if (done.count) {
      await notify({ userId: c.ownerId, type: 'campaign.completed', title: `Campaign "${c.name}" completed` });
      invalidateOwner(c.ownerId);
    }
    return true;
  }
  return false;
}

/** Process at most one recipient for a campaign. Returns 'sent' | 'failed' | 'waiting' | 'idle'. */
export async function processCampaign(c, settings) {
  const now = new Date();
  const owner = await loadUser(c.ownerId);
  if (!owner?.isActive || owner.sendingDisabled) {
    await prisma.campaign.update({ where: { id: c.id }, data: { nextSendAt: new Date(Date.now() + 5 * 60_000) } });
    return 'waiting';
  }

  if (c.type === 'FRESH') {
    // Fresh campaigns may use any of their selected mailboxes; broken ones are skipped and their recipients moved.
    const st = await rebalanceFresh(c, now);
    if (!st.sendable) {
      if (st.paused) {
        await prisma.campaign.update({ where: { id: c.id }, data: { nextSendAt: new Date(Date.now() + 5 * 60_000) } });
        return 'waiting';
      }
      await pauseCampaign(c, `No selected sending account is available (${st.unavailable.join(', ') || 'none connected'}). Reconnect one, then resume.`);
      return 'idle';
    }
  } else {
    await failUnavailableFollowUps(c);
  }

  const r = await claimRecipient(c, now);
  if (!r) {
    if (!(await maybeComplete(c))) {
      await prisma.campaign.update({ where: { id: c.id }, data: { nextSendAt: await nextWake(c, now) } });
    }
    return 'waiting';
  }

  const log = logger.child({ campaignId: c.id, employeeId: c.ownerId, accountId: r.accountId, recipientId: r.id });
  const account = await prisma.emailAccount.findUnique({ where: { id: r.accountId } });
  const limits = accountLimits(account, owner, settings, now);
  const campaignRate = Math.max(1, Math.min(c.hourlyRate, limits.hourly));

  // 1) Shared account-level reservation (pacing slot + hourly/daily/employee quotas).
  try {
    await reserveSend({ accountId: account.id, ownerId: owner.id, limits, now });
  } catch (err) {
    if (!(err instanceof QuotaError)) { await unclaim(r); throw err; }
    if (err.kind === 'SLOT') {
      await unclaim(r);
      return 'waiting';
    }
    const resumeAt = nextWindowStart(err.kind === 'HOUR' ? 'HOUR' : 'DAY', now);
    await unclaim(r, { nextAttemptAt: resumeAt });
    if (err.kind === 'EMP_DAY') {
      await prisma.campaign.update({ where: { id: c.id }, data: { nextSendAt: resumeAt } });
    } else {
      await prisma.emailAccount.update({ where: { id: account.id }, data: { nextSendAt: resumeAt } });
    }
    log.info({ quota: err.kind, resumeAt }, 'quota reached; deferring');
    return 'waiting';
  }

  // 2) Per-mailbox pacing inside this campaign (employee-selected speed per account, never above the account's limit).
  //    Other mailboxes of the same campaign can send in the meantime.
  const pacing = { ...pacingOf(c), [account.id]: new Date(now.getTime() + intervalMs(campaignRate)).toISOString() };
  for (const [id, t] of Object.entries(pacing)) if (new Date(t) <= now) delete pacing[id];
  c.accountPacing = pacing;
  await prisma.campaign.update({ where: { id: c.id }, data: { accountPacing: pacing, nextSendAt: now } });

  // 3) Last-moment gates: campaign still sending? recipient suppressed?
  const fresh = await prisma.campaign.findUnique({ where: { id: c.id }, select: { status: true } });
  if (fresh?.status !== 'SENDING' || settings.globalSendingPaused) {
    await releaseSend({ accountId: account.id, ownerId: owner.id, now });
    await unclaim(r);
    return 'idle';
  }
  const suppressed = await prisma.suppression.findFirst({ where: { email: r.email, scopeKey: { in: ['global', owner.id] } }, select: { reason: true } });
  if (suppressed) {
    await releaseSend({ accountId: account.id, ownerId: owner.id, now });
    await prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'SUPPRESSED', lockedAt: null, lockedBy: null, attempts: { decrement: 1 }, lastError: `Suppressed (${suppressed.reason})` } });
    return 'idle';
  }

  // 4) Idempotent attempt record BEFORE talking to SMTP.
  const messageId = makeMessageId(account.email);
  try {
    await prisma.sendAttempt.create({
      data: {
        recipientId: r.id, campaignId: c.id, accountId: account.id, attemptNo: r.attempts,
        idempotencyKey: `${r.id}:${r.attempts}`, messageId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.warn('duplicate attempt detected; skipping');
      return 'idle';
    }
    throw err;
  }
  await prisma.campaignRecipient.update({ where: { id: r.id }, data: { messageId } });

  const fullCampaign = await prisma.campaign.findUnique({ where: { id: c.id }, select: { subject: true, html: true, text: true } });
  const msg = buildMessage({ campaign: fullCampaign, recipient: { ...r, messageId }, account, owner, settings, messageId });

  // 5) Send.
  let info;
  try {
    info = await deliver(account, msg);
  } catch (err) {
    await handleFailure({ err, r, c, account, owner, settings, log });
    return 'failed';
  }

  // 6) Record success. If this write fails, recovery will see STARTED -> UNKNOWN (never a blind resend).
  const sentAt = new Date();
  await prisma.$transaction([
    prisma.sendAttempt.update({
      where: { idempotencyKey: `${r.id}:${r.attempts}` },
      data: { status: 'ACCEPTED', finishedAt: sentAt, response: String(info?.response || '').slice(0, 300), smtpCode: 250, messageId: info.messageId },
    }),
    prisma.campaignRecipient.update({
      where: { id: r.id },
      // The provider may have assigned its own Message-ID (Gmail API / SES); store what was actually sent.
      data: { status: 'SENT', sentAt, lockedAt: null, lockedBy: null, lastError: null, messageId: info.messageId, providerMessageId: info.providerMessageId },
    }),
    ...(account.consecutiveFailures > 0 ? [prisma.emailAccount.update({ where: { id: account.id }, data: { consecutiveFailures: 0 } })] : []),
  ]);
  log.info({ messageId: info.messageId }, 'email accepted by provider');
  return 'sent';
}

async function handleFailure({ err, r, c, account, owner, settings, log }) {
  const cls = classifySmtpError(err);
  const detail = String(err.response || err.message || 'error').slice(0, 400);
  const finishedAt = new Date();
  const attemptKey = `${r.id}:${r.attempts}`;
  log.warn({ kind: cls.kind, code: cls.code, smtpCommand: err.command }, 'send failed');

  const attemptUpdate = prisma.sendAttempt.update({
    where: { idempotencyKey: attemptKey },
    data: { status: cls.kind === 'UNCERTAIN' ? 'UNKNOWN' : 'FAILED', finishedAt, smtpCode: cls.code, response: detail, errorClass: cls.kind },
  });
  const base = { lockedAt: null, lockedBy: null, lastError: `${cls.kind}: ${detail}` };

  switch (cls.kind) {
    case 'TRANSIENT': {
      // Fresh campaigns with several mailboxes retry a temporary failure from ANOTHER selected mailbox (one extra try).
      // Follow-ups never switch mailbox.
      const others = c.type === 'FRESH' ? (c.accountIds || []).filter((id) => id !== account.id) : [];
      let altId = null;
      if (others.length) {
        const alt = await prisma.emailAccount.findFirst({ where: { id: { in: others }, deletedAt: null, adminDisabled: false, status: 'CONNECTED' }, orderBy: { consecutiveFailures: 'asc' }, select: { id: true } });
        altId = alt?.id || null;
      }
      const canRetry = r.attempts < settings.maxRetries + (altId ? 1 : 0);
      const retryData = { ...base, status: 'PENDING', nextAttemptAt: new Date(Date.now() + (altId ? 30_000 : backoffMs(r.attempts))), ...(altId ? { accountId: altId } : {}) };
      await prisma.$transaction([
        attemptUpdate,
        prisma.campaignRecipient.update({
          where: { id: r.id },
          data: canRetry ? retryData : { ...base, status: 'FAILED' },
        }),
        prisma.emailAccount.update({ where: { id: account.id }, data: { consecutiveFailures: { increment: 1 } } }),
      ]);
      if (account.consecutiveFailures + 1 >= 10) {
        await prisma.emailAccount.update({ where: { id: account.id }, data: { status: 'ERROR', lastError: `Repeated connection failures: ${detail}` } });
        await notify({ userId: owner.id, type: 'account.unhealthy', title: `${account.email} marked unhealthy`, body: detail });
        await notify({ forAdmins: true, type: 'account.unhealthy', title: `${account.email} (${owner.name}) marked unhealthy`, body: detail });
        closeTransport(account.id);
      }
      break;
    }
    case 'THROTTLED': {
      const daily = /daily|24 ?h|5\.4\.5|quota/i.test(detail);
      const resumeAt = daily ? nextWindowStart('DAY') : new Date(Date.now() + 15 * 60_000);
      await prisma.$transaction([
        attemptUpdate,
        prisma.campaignRecipient.update({ where: { id: r.id }, data: { ...base, status: 'PENDING', attempts: { decrement: 1 }, nextAttemptAt: resumeAt } }),
        prisma.emailAccount.update({ where: { id: account.id }, data: { nextSendAt: resumeAt } }),
      ]);
      break;
    }
    case 'AUTH': {
      await prisma.$transaction([
        attemptUpdate,
        prisma.campaignRecipient.update({ where: { id: r.id }, data: { ...base, status: 'PENDING', attempts: { decrement: 1 } } }),
        prisma.emailAccount.update({ where: { id: account.id }, data: { status: 'ERROR', smtpOk: false, lastError: 'SMTP authentication failed — reconnect this account' } }),
      ]);
      closeTransport(account.id);
      await notify({ userId: owner.id, type: 'account.auth_failed', title: `Authentication failed for ${account.email}`, body: 'Sending from this account is paused until you reconnect it.' });
      await notify({ forAdmins: true, type: 'account.auth_failed', title: `SMTP auth failed: ${account.email} (${owner.name})`, body: detail });
      break;
    }
    case 'INVALID_RECIPIENT': {
      await prisma.$transaction([
        attemptUpdate,
        prisma.campaignRecipient.update({ where: { id: r.id }, data: { ...base, status: 'BOUNCED', bouncedAt: finishedAt } }),
        prisma.suppression.upsert({
          where: { scopeKey_email: { scopeKey: 'global', email: r.email } },
          update: {},
          create: { scopeKey: 'global', email: r.email, reason: 'INVALID', source: `SMTP ${cls.code || ''}`.trim(), campaignId: c.id },
        }),
      ]);
      break;
    }
    case 'PERMANENT': {
      await prisma.$transaction([
        attemptUpdate,
        prisma.campaignRecipient.update({ where: { id: r.id }, data: { ...base, status: 'FAILED' } }),
      ]);
      break;
    }
    default: { // UNCERTAIN
      await prisma.$transaction([
        attemptUpdate,
        prisma.campaignRecipient.update({ where: { id: r.id }, data: { ...base, status: 'UNKNOWN', lastError: `Outcome unknown (connection dropped during send): ${detail}` } }),
      ]);
      closeTransport(account.id);
    }
  }
  invalidateOwner(owner.id);
}

/** One sending pass. Returns number of active campaigns (used to decide how long to sleep). */
export async function sendTick({ maxSends = config.workerBatchSize } = {}) {
  const settings = await getSettings();
  if (settings.globalSendingPaused) return { active: 0, sent: 0 };
  const now = new Date();
  const campaigns = await prisma.campaign.findMany({
    where: { status: 'SENDING', OR: [{ nextSendAt: null }, { nextSendAt: { lte: now } }] },
    select: { id: true, name: true, ownerId: true, accountId: true, accountIds: true, accountPacing: true, hourlyRate: true, type: true },
    orderBy: [{ nextSendAt: { sort: 'asc', nulls: 'first' } }],
    take: 20,
  });
  let sent = 0;
  // Round-robin over campaigns; a campaign with several free mailboxes may send more than once per tick.
  let progress = true;
  while (progress && sent < maxSends) {
    progress = false;
    for (const c of campaigns) {
      if (sent >= maxSends || c.done) continue;
      try {
        const result = await processCampaign(c, settings);
        if (result === 'sent' || result === 'failed') { sent += 1; progress = true; } else c.done = true;
      } catch (err) {
        c.done = true;
        logger.error({ campaignId: c.id, err: err.message }, 'campaign processing error');
      }
    }
  }
  const active = await prisma.campaign.count({ where: { status: 'SENDING' } });
  return { active, sent };
}