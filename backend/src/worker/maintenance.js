import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { invalidateOwner } from '../lib/cache.js';
import { getSettings } from '../services/settings.js';
import { findInSent, syncAccount } from '../services/imap.js';
import { notify } from '../services/audit.js';

/**
 * Recover recipients left in SENDING by a crash/restart/sleep.
 *  - attempt ACCEPTED  -> SENT (result write was lost)
 *  - attempt STARTED   -> UNKNOWN (server may have accepted it; reconcile, never blind-resend)
 *  - no attempt        -> PENDING (SMTP was never contacted)
 */
export async function recoverStuck({ onStartup = false } = {}) {
  const cutoff = new Date(Date.now() - config.stuckSendingMinutes * 60_000);
  const me = config.instanceId;
  const orphan = onStartup
    ? { OR: [{ lockedAt: { lt: cutoff } }, { lockedBy: { not: me } }, { lockedBy: null }] }
    : { lockedAt: { lt: cutoff } };
  const stuck = await prisma.campaignRecipient.findMany({
    where: { status: 'SENDING', ...orphan },
    select: { id: true, attempts: true, campaignId: true },
    take: 500,
  });
  if (!stuck.length) return { recovered: 0 };
  let sent = 0; let unknown = 0; let requeued = 0;
  for (const r of stuck) {
    const att = await prisma.sendAttempt.findUnique({ where: { idempotencyKey: `${r.id}:${r.attempts}` } });
    if (att?.status === 'ACCEPTED') {
      await prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'SENT', sentAt: att.finishedAt || att.startedAt, lockedAt: null, lockedBy: null } });
      sent += 1;
    } else if (att) {
      await prisma.$transaction([
        prisma.sendAttempt.update({ where: { id: att.id }, data: { status: 'UNKNOWN', finishedAt: new Date(), errorClass: 'INTERRUPTED' } }),
        prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'UNKNOWN', lockedAt: null, lockedBy: null, lastError: 'Worker stopped while sending — outcome unknown, needs reconciliation' } }),
      ]);
      unknown += 1;
    } else {
      await prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'PENDING', lockedAt: null, lockedBy: null, attempts: { decrement: 1 } } });
      requeued += 1;
    }
  }
  logger.info({ sent, unknown, requeued }, 'recovered interrupted sends');
  return { recovered: stuck.length, sent, unknown, requeued };
}

/** Check the Sent folder for UNKNOWN messages (by our Message-ID). Found => SENT. Not found => left for the employee. */
export async function reconcileUnknown() {
  const rows = await prisma.campaignRecipient.findMany({
    where: { status: 'UNKNOWN', holdReason: null, messageId: { not: null }, account: { imapHost: { not: null }, deletedAt: null, status: { in: ['CONNECTED', 'PAUSED'] } } },
    select: { id: true, messageId: true, accountId: true, attempts: true },
    take: 75,
  });
  const byAccount = new Map();
  for (const r of rows) {
    if (!byAccount.has(r.accountId)) byAccount.set(r.accountId, []);
    byAccount.get(r.accountId).push(r);
  }
  let resolved = 0;
  for (const [accountId, list] of [...byAccount].slice(0, 3)) {
    const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
    try {
      const found = await findInSent(account, list.map((r) => r.messageId));
      for (const r of list) {
        if (found.has(r.messageId)) {
          await prisma.$transaction([
            prisma.campaignRecipient.update({ where: { id: r.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null, holdReason: null } }),
            prisma.sendAttempt.updateMany({ where: { idempotencyKey: `${r.id}:${r.attempts}` }, data: { status: 'ACCEPTED', errorClass: 'RECONCILED' } }),
          ]);
          resolved += 1;
        } else {
          await prisma.campaignRecipient.update({ where: { id: r.id }, data: { holdReason: 'RECONCILE_NOT_FOUND' } });
        }
      }
    } catch (err) {
      logger.warn({ accountId, err: err.message }, 'reconciliation failed');
    }
  }
  return { resolved };
}

/** Start scheduled campaigns whose time has come. Conditional update => safe against duplicate schedulers. */
export async function schedulerTick() {
  const now = new Date();
  const due = await prisma.campaign.findMany({ where: { status: 'SCHEDULED', scheduledAt: { lte: now } }, select: { id: true, ownerId: true }, take: 50 });
  let started = 0;
  for (const c of due) {
    const r = await prisma.campaign.updateMany({
      where: { id: c.id, status: 'SCHEDULED' },
      data: { status: 'SENDING', startedAt: now, nextSendAt: now },
    });
    if (r.count) { started += 1; invalidateOwner(c.ownerId); }
  }
  return { started };
}

/** Incremental IMAP sync for a few due accounts per tick (bounded work per wake-up). */
export async function imapTick({ maxAccounts = 3 } = {}) {
  const settings = await getSettings();
  const now = new Date();
  const due = await prisma.emailAccount.findMany({
    where: {
      deletedAt: null, adminDisabled: false, imapHost: { not: null }, status: { in: ['CONNECTED', 'PAUSED'] },
      OR: [{ imapNextSyncAt: null }, { imapNextSyncAt: { lte: now } }],
    },
    orderBy: [{ imapNextSyncAt: { sort: 'asc', nulls: 'first' } }],
    take: maxAccounts,
  });
  const results = [];
  for (const account of due) {
    // Claim first so a concurrent instance won't sync the same mailbox.
    const claim = await prisma.emailAccount.updateMany({
      where: { id: account.id, OR: [{ imapNextSyncAt: null }, { imapNextSyncAt: { lte: now } }] },
      data: { imapNextSyncAt: new Date(Date.now() + settings.imapSyncIntervalMin * 60_000) },
    });
    if (!claim.count) continue;
    try {
      const r = await syncAccount(account);
      results.push({ accountId: account.id, ...r });
      if (r.replies || r.bounces) invalidateOwner(account.ownerId);
    } catch (err) {
      logger.warn({ accountId: account.id, err: err.message }, 'imap sync failed');
      await prisma.emailAccount.update({
        where: { id: account.id },
        data: { imapOk: false, lastError: `IMAP: ${String(err.responseText || err.message).slice(0, 200)}` },
      });
    }
  }
  return results;
}

/** Pause accounts whose bounce rate crosses the admin threshold (min sample size to avoid noise). */
export async function accountHealthTick() {
  const settings = await getSettings();
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await prisma.campaignRecipient.groupBy({
    by: ['accountId', 'status'],
    where: { sentAt: { gte: since }, status: { in: ['SENT', 'BOUNCED'] }, accountId: { not: null } },
    _count: { _all: true },
  });
  const agg = new Map();
  for (const r of rows) {
    const e = agg.get(r.accountId) || { sent: 0, bounced: 0 };
    e.sent += r._count._all;
    if (r.status === 'BOUNCED') e.bounced += r._count._all;
    agg.set(r.accountId, e);
  }
  for (const [accountId, e] of agg) {
    if (e.sent < 20) continue;
    const rate = e.bounced / e.sent;
    if (rate <= settings.bounceRatePauseThreshold) continue;
    const res = await prisma.emailAccount.updateMany({
      where: { id: accountId, status: 'CONNECTED' },
      data: { status: 'PAUSED', lastError: `Auto-paused: 7-day bounce rate ${(rate * 100).toFixed(1)}% exceeds ${(settings.bounceRatePauseThreshold * 100).toFixed(1)}%` },
    });
    if (res.count) {
      const acc = await prisma.emailAccount.findUnique({ where: { id: accountId }, select: { email: true, ownerId: true } });
      await notify({ userId: acc.ownerId, type: 'account.auto_paused', title: `${acc.email} paused for high bounce rate`, body: 'Clean your list, then ask your admin to resume the account.' });
      await notify({ forAdmins: true, type: 'account.auto_paused', title: `${acc.email} auto-paused (bounce rate ${(rate * 100).toFixed(1)}%)` });
    }
  }
}

/** Keep Neon storage small: prune short-lived operational rows. */
export async function cleanupTick() {
  const d = (days) => new Date(Date.now() - days * 86_400_000);
  await prisma.usageCounter.deleteMany({ where: { windowStart: { lt: d(3) } } });
  await prisma.healthCheck.deleteMany({ where: { createdAt: { lt: d(7) } } });
  await prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: d(1) } } });
  await prisma.authChallenge.deleteMany({ where: { expiresAt: { lt: d(1) } } });
  await prisma.notification.deleteMany({ where: { createdAt: { lt: d(60) }, readAt: { not: null } } });
}
