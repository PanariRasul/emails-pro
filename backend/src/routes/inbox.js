// Employee inbox (campaign replies), employee dashboard/reports, sending history and notifications.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { caches } from '../lib/cache.js';
import { ah, notFound } from '../lib/errors.js';
import { idParam, pagination, validate } from '../middleware/common.js';
import { employeeOnly, requireAuth } from '../middleware/auth.js';
import { getSettings } from '../services/settings.js';
import { dayWindow, employeeLimits } from '../services/limits.js';
import { WORKING_STATUSES, statsFor } from '../services/campaigns.js';
import { workerState } from '../worker/index.js';
import { config, trackingReachable } from '../config/index.js';
import { syncAccount } from '../services/imap.js';
import { buildVars, renderTemplate } from '../services/template.js';
import { invalidateOwner } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { rateLimit } from '../lib/rateLimit.js';

// ======================= Inbox =======================
export const inboxRouter = Router();
inboxRouter.use(employeeOnly);

inboxRouter.get('/', validate({ query: pagination.extend({
  unread: z.enum(['true', 'false']).optional(), bounces: z.enum(['true', 'false']).optional(),
  spam: z.enum(['true', 'false']).optional(), search: z.string().trim().max(200).optional(),
}) }), ah(async (req, res) => {
  const { page, pageSize, unread, bounces, spam, search } = req.query;
  const where = {
    ownerId: req.user.id, direction: 'INBOUND', deletedAt: null,
    ...(unread === 'true' ? { isRead: false } : {}),
    ...(spam === 'true' ? { folder: 'SPAM' } : { isBounce: bounces === 'true' }),
    ...(search ? { OR: [{ fromAddr: { contains: search.toLowerCase() } }, { subject: { contains: search, mode: 'insensitive' } }] } : {}),
  };
  const [items, total, unreadCount] = await Promise.all([
    prisma.emailMessage.findMany({
      where,
      select: { id: true, fromAddr: true, toAddr: true, subject: true, receivedAt: true, isRead: true, isBounce: true, folder: true, campaignId: true, recipientId: true, text: true, account: { select: { email: true } } },
      orderBy: { receivedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
    }),
    prisma.emailMessage.count({ where }),
    prisma.emailMessage.count({ where: { ownerId: req.user.id, direction: 'INBOUND', isRead: false, isBounce: false, deletedAt: null } }),
  ]);
  const campaignIds = [...new Set(items.map((i) => i.campaignId).filter(Boolean))];
  const names = new Map((await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  res.json({
    items: items.map((i) => ({ ...i, snippet: replySnippet(i.text), text: undefined, campaignName: names.get(i.campaignId) || null })),
    total, page, pageSize, unread: unreadCount,
  });
}));

/** First lines of the reply only (without the quoted original). */
function replySnippet(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cut = lines.findIndex((l) => /^\s*>/.test(l) || /^On\b.{3,200}\bwrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()) || /^From:\s/.test(l.trim()));
  return (cut === -1 ? lines : lines.slice(0, cut)).join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// Manual "Check now": sync this employee's mailboxes immediately (bounded so the request stays fast).
inboxRouter.post('/sync', rateLimit({ name: 'inbox-sync', max: 6, windowSec: 60, key: (req) => req.user.id }), ah(async (req, res) => {
  const accounts = await prisma.emailAccount.findMany({
    where: { ownerId: req.user.id, deletedAt: null, adminDisabled: false, imapHost: { not: null }, status: { in: ['CONNECTED', 'PAUSED'] } },
    orderBy: { imapLastSyncAt: { sort: 'asc', nulls: 'first' } },
    take: 10,
  });
  const started = Date.now();
  const result = { accounts: accounts.length, checked: 0, replies: 0, bounces: 0, errors: [] };
  for (const account of accounts) {
    if (Date.now() - started > 25_000) break; // keep the request short; the worker continues the rest
    try {
      const r = await syncAccount(account);
      result.checked += 1; result.replies += r.replies || 0; result.bounces += r.bounces || 0;
    } catch (err) {
      logger.warn({ accountId: account.id, err: err.message }, 'manual imap sync failed');
      result.errors.push({ email: account.email, error: String(err.responseText || err.message).slice(0, 160) });
      await prisma.emailAccount.update({ where: { id: account.id }, data: { imapOk: false, lastError: `IMAP: ${String(err.responseText || err.message).slice(0, 200)}` } });
    }
  }
  // Remaining mailboxes are picked up by the background worker right away.
  await prisma.emailAccount.updateMany({ where: { ownerId: req.user.id, deletedAt: null, imapHost: { not: null } }, data: { imapNextSyncAt: new Date() } });
  invalidateOwner(req.user.id);
  res.json(result);
}));

inboxRouter.get('/:id', validate({ params: idParam }), ah(async (req, res) => {
  const msg = await prisma.emailMessage.findFirst({ where: { id: req.params.id, ownerId: req.user.id, deletedAt: null }, include: { account: { select: { email: true, displayName: true } } } });
  if (!msg) throw notFound('Message');
  if (!msg.isRead) await prisma.emailMessage.update({ where: { id: msg.id }, data: { isRead: true } });
  const campaign = msg.campaignId ? await prisma.campaign.findUnique({ where: { id: msg.campaignId }, select: { id: true, name: true } }) : null;
  // The whole conversation with this recipient: what we sent (all campaigns/follow-ups) and every reply.
  let thread = [];
  if (msg.recipientId) {
    const rec = await prisma.campaignRecipient.findUnique({ where: { id: msg.recipientId }, select: { email: true, campaign: { select: { ownerId: true } } } });
    if (rec && rec.campaign.ownerId === req.user.id) {
      const [sent, replies] = await Promise.all([
        prisma.campaignRecipient.findMany({
          where: { email: rec.email, campaign: { ownerId: req.user.id }, sentAt: { not: null } },
          select: { id: true, email: true, vars: true, sentAt: true, subject: true, status: true, openedAt: true, clickedAt: true, campaign: { select: { id: true, name: true, subject: true, type: true } }, account: { select: { email: true, displayName: true } } },
          orderBy: { sentAt: 'asc' }, take: 20,
        }),
        prisma.emailMessage.findMany({
          where: { ownerId: req.user.id, deletedAt: null, OR: [{ fromAddr: rec.email }, { recipientId: msg.recipientId }] },
          select: { id: true, receivedAt: true, subject: true, isBounce: true, folder: true, fromAddr: true },
          orderBy: { receivedAt: 'asc' }, take: 50,
        }),
      ]);
      thread = [
        // Show the subject exactly as the person received it (variables filled in).
        ...sent.map((x) => ({ kind: 'SENT', at: x.sentAt, subject: renderTemplate(x.subject || x.campaign.subject, buildVars({ recipient: x, owner: req.user, account: x.account })), campaign: x.campaign, from: x.account?.email, status: x.status, openedAt: x.openedAt, clickedAt: x.clickedAt })),
        ...replies.map((x) => ({ kind: x.isBounce ? 'BOUNCE' : 'REPLY', at: x.receivedAt, subject: x.subject, id: x.id, folder: x.folder, current: x.id === msg.id })),
      ].sort((a, b) => new Date(a.at) - new Date(b.at));
    }
  }
  res.json({ message: { ...msg, isRead: true }, campaign, thread, sanitized: true });
}));

inboxRouter.post('/read-all', ah(async (req, res) => {
  const r = await prisma.emailMessage.updateMany({ where: { ownerId: req.user.id, isRead: false, deletedAt: null }, data: { isRead: true } });
  res.json({ updated: r.count });
}));

// Delete = hide from the inbox. The record is kept (marked deleted) so the next sync never brings it back,
// and the recipient stays marked as replied/bounced so follow-ups still exclude them.
inboxRouter.post('/delete', validate({ body: z.object({ ids: z.array(z.string().max(40)).min(1).max(500) }) }), ah(async (req, res) => {
  const r = await prisma.emailMessage.updateMany({ where: { id: { in: req.body.ids }, ownerId: req.user.id, deletedAt: null }, data: { deletedAt: new Date(), isRead: true } });
  invalidateOwner(req.user.id);
  res.json({ deleted: r.count });
}));

inboxRouter.delete('/:id', validate({ params: idParam }), ah(async (req, res) => {
  const r = await prisma.emailMessage.updateMany({ where: { id: req.params.id, ownerId: req.user.id, deletedAt: null }, data: { deletedAt: new Date(), isRead: true } });
  if (!r.count) throw notFound('Message');
  invalidateOwner(req.user.id);
  res.json({ deleted: r.count });
}));

// ======================= Employee reports =======================
export const reportsRouter = Router();
reportsRouter.use(employeeOnly);

reportsRouter.get('/dashboard', ah(async (req, res) => {
  const uid = req.user.id;
  const data = await caches.dashboard.wrap(`emp:${uid}:dashboard`, async () => {
    const settings = await getSettings();
    const limits = employeeLimits(req.user, settings);
    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const [accounts, working, sentTodayRow, totals, unread, recent, worker] = await Promise.all([
      prisma.emailAccount.groupBy({ by: ['status'], where: { ownerId: uid, deletedAt: null }, _count: { _all: true } }),
      prisma.campaign.count({ where: { ownerId: uid, archived: false, status: { in: WORKING_STATUSES } } }),
      prisma.usageCounter.findUnique({ where: { scope_windowStart: { scope: `emp:${uid}:day`, windowStart: dayWindow() } } }),
      prisma.$queryRaw`
        SELECT count(*) FILTER (WHERE r.status = 'SENT')::int AS sent,
               count(r."openedAt")::int AS opened, count(r."clickedAt")::int AS clicked,
               count(r."repliedAt")::int AS replied, count(*) FILTER (WHERE r.status = 'BOUNCED')::int AS bounced,
               count(*) FILTER (WHERE r.status = 'FAILED')::int AS failed, count(*) FILTER (WHERE r.status = 'UNKNOWN')::int AS unknown,
               count(*) FILTER (WHERE r.status = 'ON_HOLD')::int AS "onHold", count(r."unsubscribedAt")::int AS unsubscribed
        FROM "CampaignRecipient" r JOIN "Campaign" c ON c.id = r."campaignId"
        WHERE c."ownerId" = ${uid} AND (r."sentAt" >= ${since30} OR r.status::text IN ('UNKNOWN', 'ON_HOLD', 'FAILED') AND r."createdAt" >= ${since30})`,
      prisma.emailMessage.count({ where: { ownerId: uid, direction: 'INBOUND', isRead: false, isBounce: false, deletedAt: null } }),
      prisma.campaign.findMany({
        where: { ownerId: uid, archived: false }, orderBy: { createdAt: 'desc' }, take: 6,
        select: { id: true, name: true, status: true, type: true, scheduledAt: true, startedAt: true, pausedReason: true },
      }),
      Promise.resolve(workerState()),
    ]);
    const stats = await statsFor(recent.map((c) => c.id));
    const accountCount = accounts.reduce((s, a) => s + a._count._all, 0);
    return {
      accounts: { total: accountCount, byStatus: Object.fromEntries(accounts.map((a) => [a.status, a._count._all])), limit: limits.accounts, remaining: Math.max(0, limits.accounts - accountCount) },
      campaigns: { working, limit: settings.maxWorkingCampaigns },
      quota: { sentToday: sentTodayRow?.count || 0, dailyLimit: limits.daily, hourlyPerAccount: limits.hourly },
      last30Days: totals[0],
      unreadReplies: unread,
      recent: recent.map((c) => ({ ...c, stats: stats.get(c.id) })),
      sending: { globalPaused: settings.globalSendingPaused, disabled: req.user.sendingDisabled, workerLastTick: worker.lastTickAt },
      tracking: { enabled: settings.trackingEnabled, reachable: trackingReachable(), url: config.publicApiUrl },
    };
  }, 30_000);
  res.json(data);
}));

reportsRouter.get('/analytics', validate({ query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }) }), ah(async (req, res) => {
  const since = new Date(Date.now() - req.query.days * 86_400_000);
  const key = `emp:${req.user.id}:analytics:${req.query.days}`;
  const data = await caches.stats.wrap(key, async () => {
    const daily = await prisma.$queryRaw`
      SELECT to_char(date_trunc('day', r."sentAt"), 'YYYY-MM-DD') AS day,
             count(*)::int AS sent, count(r."openedAt")::int AS opened, count(r."clickedAt")::int AS clicked,
             count(r."repliedAt")::int AS replied, count(*) FILTER (WHERE r.status = 'BOUNCED')::int AS bounced
      FROM "CampaignRecipient" r JOIN "Campaign" c ON c.id = r."campaignId"
      WHERE c."ownerId" = ${req.user.id} AND r."sentAt" >= ${since}
      GROUP BY 1 ORDER BY 1`;
    const byAccount = await prisma.$queryRaw`
      SELECT a.email, count(*)::int AS sent, count(r."repliedAt")::int AS replied,
             count(*) FILTER (WHERE r.status = 'BOUNCED')::int AS bounced
      FROM "CampaignRecipient" r JOIN "EmailAccount" a ON a.id = r."accountId"
      WHERE a."ownerId" = ${req.user.id} AND r."sentAt" >= ${since}
      GROUP BY a.email ORDER BY sent DESC LIMIT 50`;
    return { daily, byAccount };
  }, 60_000);
  res.json({ ...data, tracking: { reachable: trackingReachable(), url: config.publicApiUrl }, note: 'Opens and clicks are approximate: image blocking, privacy proxies and security scanners affect them.' });
}));

reportsRouter.get('/history', validate({ query: pagination.extend({ campaignId: z.string().max(40).optional(), status: z.string().max(20).optional() }) }), ah(async (req, res) => {
  const { page, pageSize, campaignId, status } = req.query;
  const campaigns = await prisma.campaign.findMany({ where: { ownerId: req.user.id, ...(campaignId ? { id: campaignId } : {}) }, select: { id: true, name: true } });
  const names = new Map(campaigns.map((c) => [c.id, c.name]));
  const where = { campaignId: { in: [...names.keys()] }, ...(status ? { status } : {}) };
  const [items, total] = await Promise.all([
    prisma.sendAttempt.findMany({
      where,
      select: { id: true, campaignId: true, accountId: true, attemptNo: true, status: true, smtpCode: true, response: true, errorClass: true, startedAt: true, finishedAt: true, messageId: true, recipient: { select: { email: true, status: true } } },
      orderBy: { startedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
    }),
    prisma.sendAttempt.count({ where }),
  ]);
  const accIds = [...new Set(items.map((i) => i.accountId))];
  const accs = new Map((await prisma.emailAccount.findMany({ where: { id: { in: accIds } }, select: { id: true, email: true } })).map((a) => [a.id, a.email]));
  res.json({ items: items.map((i) => ({ ...i, campaignName: names.get(i.campaignId), accountEmail: accs.get(i.accountId) })), total, page, pageSize });
}));

// ======================= Notifications =======================
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const notifWhere = (user) => (user.role === 'ADMIN' ? { OR: [{ forAdmins: true }, { userId: user.id }] } : { userId: user.id });

notificationsRouter.get('/', ah(async (req, res) => {
  const where = notifWhere(req.user);
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ]);
  res.json({ items, unread });
}));

notificationsRouter.post('/read', validate({ body: z.object({ ids: z.array(z.string().max(40)).max(100).optional() }) }), ah(async (req, res) => {
  const where = { ...notifWhere(req.user), readAt: null, ...(req.body.ids ? { id: { in: req.body.ids } } : {}) };
  const r = await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
  res.json({ updated: r.count });
}));