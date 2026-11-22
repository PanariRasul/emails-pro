import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { config, trackingReachable } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { caches, invalidateOwner } from '../lib/cache.js';
import { randomToken } from '../lib/crypto.js';
import { ah, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { rateLimit } from '../lib/rateLimit.js';
import { idParam, pagination, validate } from '../middleware/common.js';
import { employeeOnly } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';
import { accountLimits } from '../services/limits.js';
import { buildMessage, htmlToText, makeMessageId, sanitizeEmailHtml } from '../services/template.js';
import { deliver } from '../services/transports.js';
import {
  MAX_RECIPIENTS_PER_CAMPAIGN, WORKING_STATUSES, cachedStats, lockCampaigns, snapshotRecipients, statsFor, workingCampaignCount,
} from '../services/campaigns.js';
import { wakeWorker } from '../worker/index.js';

const router = Router();
router.use(employeeOnly); // Admins can monitor/pause via /api/admin, but never create or send.

const CAMPAIGN_LIST = {
  id: true, name: true, type: true, status: true, archived: true, accountId: true, parentId: true, subject: true,
  hourlyRate: true, scheduledAt: true, startedAt: true, completedAt: true, pausedReason: true, pausedByAdmin: true,
  createdAt: true, accountIds: true, account: { select: { email: true, status: true } },
};

async function ownedCampaign(req, id, select) {
  const c = await prisma.campaign.findFirst({ where: { id, ownerId: req.user.id }, ...(select ? { select } : {}) });
  if (!c) throw notFound('Campaign');
  return c;
}

/** All selected mailboxes must belong to the employee and not be deleted. Returns them in the chosen order. */
async function ownedAccounts(req, ids) {
  const unique = [...new Set(ids)];
  const accs = await prisma.emailAccount.findMany({ where: { id: { in: unique }, ownerId: req.user.id, deletedAt: null } });
  if (accs.length !== unique.length) throw badRequest('Choose your own connected email accounts');
  const byId = new Map(accs.map((a) => [a.id, a]));
  return unique.map((id) => byId.get(id));
}

const isSendable = (a) => a && !a.deletedAt && !a.adminDisabled && a.status === 'CONNECTED';

/**
 * Split a fresh campaign's unsent recipients evenly across its mailboxes (round-robin:
 * 500 recipients over 10 mailboxes = 50 each). Never touches recipients that were already sent.
 */
async function distributeRecipients(tx, campaignId, accountIds) {
  if (!accountIds.length) return;
  await tx.$executeRaw`
    UPDATE "CampaignRecipient" r
       SET "accountId" = (${accountIds}::text[])[((s.rn % ${accountIds.length}) + 1)::int]
      FROM (SELECT id, row_number() OVER (ORDER BY id) - 1 AS rn
              FROM "CampaignRecipient" WHERE "campaignId" = ${campaignId} AND status IN ('PENDING','ON_HOLD')) s
     WHERE r.id = s.id`;
}

async function usableAccount(req, accountId) {
  const acc = await prisma.emailAccount.findFirst({ where: { id: accountId, ownerId: req.user.id, deletedAt: null } });
  if (!acc) throw badRequest('Choose one of your connected email accounts');
  return acc;
}

/**
 * Spread a pitch's subject lines evenly across a FRESH campaign's unsent recipients (round-robin).
 * With one subject (or rotation off) the per-recipient subject is cleared so the campaign subject applies.
 */
async function applySubjectRotation(tx, campaignId, subjects) {
  if (!subjects || subjects.length < 2) {
    await tx.$executeRaw`UPDATE "CampaignRecipient" SET subject = NULL WHERE "campaignId" = ${campaignId} AND status IN ('PENDING','ON_HOLD')`;
    return;
  }
  await tx.$executeRaw`
    UPDATE "CampaignRecipient" r
       SET subject = (${subjects}::text[])[((s.rn % ${subjects.length}) + 1)::int]
      FROM (SELECT id, row_number() OVER (ORDER BY id) - 1 AS rn
              FROM "CampaignRecipient" WHERE "campaignId" = ${campaignId} AND status IN ('PENDING','ON_HOLD')) s
     WHERE r.id = s.id`;
}

async function pitchSubjects(tx, pitchVersionId) {
  if (!pitchVersionId) return null;
  const v = await tx.pitchVersion.findUnique({ where: { id: pitchVersionId }, select: { subjects: true } });
  return v?.subjects || null;
}

async function resolveContent(req, b) {
  if (b.pitchVersionId) {
    const v = await prisma.pitchVersion.findFirst({ where: { id: b.pitchVersionId, pitch: { ownerId: req.user.id } } });
    if (!v) throw badRequest('Pitch not found');
    return { pitchVersionId: v.id, subject: b.subject || v.subjects[0] || '', html: v.html, text: v.text };
  }
  if (!b.subject || !b.html) throw badRequest('Subject and email content are required (or choose a pitch)');
  const html = sanitizeEmailHtml(b.html);
  return { pitchVersionId: null, subject: b.subject, html, text: b.text?.trim() || htmlToText(html) };
}

// ---------- list / detail ----------
router.get('/', validate({ query: pagination.extend({ archived: z.enum(['true', 'false']).default('false'), status: z.string().optional() }) }), ah(async (req, res) => {
  const { page, pageSize, archived, status } = req.query;
  const key = `emp:${req.user.id}:list:${page}:${pageSize}:${archived}:${status || ''}`;
  const data = await caches.stats.wrap(key, async () => {
    const where = { ownerId: req.user.id, archived: archived === 'true', ...(status ? { status } : {}) };
    const [items, total, working] = await Promise.all([
      prisma.campaign.findMany({ where, select: CAMPAIGN_LIST, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.campaign.count({ where }),
      workingCampaignCount(prisma, req.user.id),
    ]);
    const stats = await statsFor(items.map((c) => c.id));
    const settings = await getSettings();
    return {
      items: items.map((c) => ({ ...c, stats: stats.get(c.id) })),
      total, page, pageSize,
      working: { count: working, limit: settings.maxWorkingCampaigns },
    };
  }, 15_000);
  res.json(data);
}));

router.get('/:id', validate({ params: idParam }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id, {
    ...CAMPAIGN_LIST, html: true, text: true, pitchVersionId: true, approvedAt: true,
    parent: { select: { id: true, name: true } }, followUps: { select: { id: true, name: true, status: true } },
  });
  const rows = await prisma.campaignRecipient.groupBy({ by: ['accountId', 'status'], where: { campaignId: c.id }, _count: { _all: true } });
  const accIds = [...new Set([...(c.accountIds || []), ...rows.map((r) => r.accountId).filter(Boolean)])];
  const accs = await prisma.emailAccount.findMany({ where: { id: { in: accIds } }, select: { id: true, email: true, displayName: true, status: true, deletedAt: true, adminDisabled: true, groupName: true, provider: true } });
  const accounts = accIds.map((id) => {
    const a = accs.find((x) => x.id === id);
    const counts = Object.fromEntries(rows.filter((r) => r.accountId === id).map((r) => [r.status, r._count._all]));
    const total = Object.values(counts).reduce((x, y) => x + y, 0);
    return { id, email: a?.email || 'removed account', displayName: a?.displayName, groupName: a?.groupName, provider: a?.provider, usable: isSendable(a), status: a?.deletedAt ? 'REMOVED' : a?.status, total, counts };
  });
  res.json({ campaign: { ...c, stats: await cachedStats(req.user.id, c.id) }, accounts });
}));

router.get('/:id/recipients', validate({
  params: idParam,
  query: pagination.extend({ status: z.string().max(20).optional(), search: z.string().max(200).optional() }),
}), ah(async (req, res) => {
  await ownedCampaign(req, req.params.id, { id: true });
  const { page, pageSize, status, search } = req.query;
  const where = {
    campaignId: req.params.id,
    ...(status ? { status } : {}),
    ...(search ? { email: { contains: search.toLowerCase() } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.campaignRecipient.findMany({
      where,
      select: {
        id: true, email: true, status: true, holdReason: true, attempts: true, sentAt: true, lastError: true,
        openedAt: true, openCount: true, clickedAt: true, clickCount: true, repliedAt: true, unsubscribedAt: true, bouncedAt: true,
        nextAttemptAt: true, vars: true, subject: true, account: { select: { email: true, status: true, deletedAt: true } },
      },
      orderBy: { id: 'asc' }, skip: (page - 1) * pageSize, take: pageSize,
    }),
    prisma.campaignRecipient.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
}));

router.get('/:id/recipients/export', validate({ params: idParam, query: z.object({ status: z.string().max(20).default('FAILED') }) }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id, { id: true, name: true });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${c.name.replace(/[^a-z0-9-_]+/gi, '_')}-${req.query.status.toLowerCase()}.csv"`);
  res.write('email,status,attempts,last_error,sent_at\n');
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  let cursor = null;
  for (;;) {
    const rows = await prisma.campaignRecipient.findMany({
      where: { campaignId: c.id, status: req.query.status },
      select: { id: true, email: true, status: true, attempts: true, lastError: true, sentAt: true },
      orderBy: { id: 'asc' }, take: 1000, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    res.write(rows.map((r) => [r.email, r.status, r.attempts, r.lastError, r.sentAt?.toISOString()].map(esc).join(',')).join('\n') + '\n');
    if (rows.length < 1000) break;
  }
  res.end();
}));

// ---------- create ----------
const contentFields = {
  pitchVersionId: z.string().max(40).optional().nullable(),
  subject: z.string().trim().max(250).optional(),
  html: z.string().max(200_000).optional(),
  text: z.string().max(100_000).optional(),
  // Pitch only: send each recipient one of the pitch's subject lines in turn.
  rotateSubjects: z.boolean().optional(),
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  // One or more sending mailboxes. `accountId` is still accepted for older clients.
  accountIds: z.array(z.string().min(1).max(40)).min(1).max(100).optional(),
  accountId: z.string().min(1).max(40).optional(),
  listIds: z.array(z.string().max(40)).min(1).max(20),
  hourlyRate: z.coerce.number().int().min(1).max(3600).default(30),
  ...contentFields,
});

router.post('/', rateLimit({ name: 'campaign-create', max: 30, windowSec: 3600, key: (req) => req.user.id }), validate({ body: createSchema }), ah(async (req, res) => {
  const settings = await getSettings();
  const b = req.body;
  const ids = b.accountIds?.length ? b.accountIds : (b.accountId ? [b.accountId] : []);
  if (!ids.length) throw badRequest('Choose at least one sending account');
  const accounts = await ownedAccounts(req, ids);
  const maxHourly = Math.max(...accounts.map((a) => accountLimits(a, req.user, settings).hourly));
  if (b.hourlyRate > maxHourly) throw badRequest(`Sending speed can't exceed ${maxHourly} emails/hour per account`);
  const account = accounts[0];
  const content = await resolveContent(req, b);
  const lists = await prisma.recipientList.count({ where: { id: { in: b.listIds }, ownerId: req.user.id } });
  if (lists !== b.listIds.length) throw badRequest('One or more recipient lists were not found');

  const result = await prisma.$transaction(async (tx) => {
    await lockCampaigns(tx, req.user.id);
    const working = await workingCampaignCount(tx, req.user.id);
    if (working >= settings.maxWorkingCampaigns) {
      throw conflict(`You already have ${working} working campaigns (limit ${settings.maxWorkingCampaigns}). Archive a completed or cancelled campaign first.`, 'CAMPAIGN_LIMIT');
    }
    const campaign = await tx.campaign.create({
      data: { ownerId: req.user.id, name: b.name, type: 'FRESH', accountId: account.id, accountIds: accounts.map((a) => a.id), hourlyRate: b.hourlyRate, ...content },
    });
    const snap = await snapshotRecipients(tx, { campaignId: campaign.id, ownerId: req.user.id, listIds: b.listIds });
    if (snap.inserted === 0) throw badRequest('No sendable recipients — the selected lists are empty or fully suppressed');
    await distributeRecipients(tx, campaign.id, accounts.map((a) => a.id));
    if (b.rotateSubjects && content.pitchVersionId) await applySubjectRotation(tx, campaign.id, await pitchSubjects(tx, content.pitchVersionId));
    return { campaign, snap };
  }, { timeout: 60_000, maxWait: 10_000 }).catch((err) => {
    if (err.status === 400) throw badRequest(err.message);
    throw err;
  });

  invalidateOwner(req.user.id);
  audit(req, 'campaign.created', 'Campaign', result.campaign.id, { recipients: result.snap.inserted });
  res.status(201).json({ campaign: result.campaign, recipients: result.snap });
}));

// ---------- edit ----------
const updateSchema = z.object({
  name: z.string().trim().min(1).max(150).optional(),
  accountId: z.string().max(40).optional(),
  accountIds: z.array(z.string().min(1).max(40)).min(1).max(100).optional(),
  hourlyRate: z.coerce.number().int().min(1).max(3600).optional(),
  ...contentFields,
});

router.patch('/:id', validate({ params: idParam, body: updateSchema }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id);
  if (!['DRAFT', 'PAUSED', 'SCHEDULED', 'PENDING_APPROVAL'].includes(c.status)) throw conflict('Only draft, scheduled or paused campaigns can be edited');
  const b = req.body;
  const settings = await getSettings();
  const data = {};
  if (b.name) data.name = b.name;
  const newIds = b.accountIds?.length ? b.accountIds : (b.accountId ? [b.accountId] : null);
  let redistribute = null;
  if (newIds && JSON.stringify(newIds) !== JSON.stringify(c.accountIds)) {
    // Fresh campaigns may change mailboxes until they finish; already-sent emails keep their sender.
    if (c.type !== 'FRESH' || !['DRAFT', 'PAUSED', 'SCHEDULED', 'PENDING_APPROVAL'].includes(c.status)) throw conflict('Sending accounts can only be changed on draft, scheduled or paused fresh campaigns');
    const accs = await ownedAccounts(req, newIds);
    data.accountId = accs[0].id;
    data.accountIds = accs.map((a) => a.id);
    data.accountPacing = Prisma.DbNull;
    redistribute = data.accountIds;
  }
  if (b.hourlyRate) {
    if (c.type === 'FRESH') {
      const accs = await ownedAccounts(req, data.accountIds || (c.accountIds.length ? c.accountIds : [c.accountId]));
      const maxHourly = Math.max(...accs.map((a) => accountLimits(a, req.user, settings).hourly));
      if (b.hourlyRate > maxHourly) throw badRequest(`Sending speed can't exceed ${maxHourly} emails/hour per account`);
    }
    data.hourlyRate = b.hourlyRate;
  }
  if (b.pitchVersionId || b.html || b.subject) Object.assign(data, await resolveContent(req, { ...c, pitchVersionId: null, ...b }));
  if (c.status === 'PENDING_APPROVAL') data.status = 'DRAFT';
  if (req.user.requireApproval && c.approvedAt) data.approvedAt = null; // edits after approval need re-approval
  const contentChanged = Boolean(b.pitchVersionId || b.html || b.subject) || b.rotateSubjects !== undefined;
  const campaign = await prisma.$transaction(async (tx) => {
    const updated = await tx.campaign.update({ where: { id: c.id }, data });
    if (redistribute) await distributeRecipients(tx, c.id, redistribute);
    // Follow-ups keep their per-recipient "Re:" subjects; fresh campaigns re-apply rotation for unsent recipients.
    if (contentChanged && c.type === 'FRESH') {
      const subjects = b.rotateSubjects ? await pitchSubjects(tx, updated.pitchVersionId) : null;
      await applySubjectRotation(tx, c.id, subjects);
    }
    return updated;
  });
  invalidateOwner(req.user.id);
  audit(req, 'campaign.updated', 'Campaign', c.id);
  res.json({ campaign });
}));

// ---------- review / test ----------
router.get('/:id/review', validate({ params: idParam }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id);
  const settings = await getSettings();
  const stats = await cachedStats(req.user.id, c.id);
  let estimate = null;
  const ids = c.type === 'FRESH' ? (c.accountIds.length ? c.accountIds : [c.accountId].filter(Boolean))
    : (await prisma.campaignRecipient.findMany({ where: { campaignId: c.id, accountId: { not: null } }, distinct: ['accountId'], select: { accountId: true } })).map((r) => r.accountId);
  if (ids.length) {
    const accs = await prisma.emailAccount.findMany({ where: { id: { in: ids } } });
    const usable = accs.filter(isSendable);
    const lims = usable.map((a) => accountLimits(a, req.user, settings));
    const rate = lims.reduce((sum, l) => sum + Math.min(c.hourlyRate, l.hourly), 0);
    const dailyCap = lims.reduce((sum, l) => sum + l.daily, 0);
    const remaining = stats.pending;
    estimate = {
      ratePerHour: rate, dailyCap, accounts: ids.length, usableAccounts: usable.length,
      hours: rate ? Math.round((remaining / rate) * 10) / 10 : null, days: dailyCap ? Math.ceil(remaining / dailyCap) : null,
      warmupActive: lims.some((l) => l.warmupActive),
    };
  }
  const checks = [];
  if (!settings.trackingEnabled) checks.push({ level: 'info', message: 'Open and click tracking is switched off by your administrator.' });
  else if (!trackingReachable()) checks.push({ level: 'warn', message: `Opens and clicks can't be counted yet: tracking links point to ${config.publicApiUrl}, which recipients can't reach. They work once the app is deployed with a public address (PUBLIC_API_URL). Replies and bounces are still detected.` });
  if (!/\{\{\s*unsubscribeUrl\s*\}\}/.test(settings.footerHtml)) checks.push({ level: 'info', message: 'Unsubscribe footer is added automatically.' });
  if (!c.text?.trim()) checks.push({ level: 'warn', message: 'No plain-text version; one will be generated from the HTML.' });
  if (/<img/i.test(c.html) && htmlToText(c.html).length < 40) checks.push({ level: 'warn', message: 'Message relies mostly on images; add text content.' });
  res.json({ stats, estimate, checks, requireApproval: req.user.requireApproval, globalPaused: settings.globalSendingPaused });
}));

router.post('/:id/test', rateLimit({ name: 'campaign-test', max: 15, windowSec: 3600, key: (req) => req.user.id }),
  validate({ params: idParam, body: z.object({ to: z.string().trim().toLowerCase().email(), accountId: z.string().max(40).optional() }) }),
  ah(async (req, res) => {
    const c = await ownedCampaign(req, req.params.id);
    const account = await usableAccount(req, req.body.accountId || c.accountId);
    if (account.status !== 'CONNECTED' || account.adminDisabled) throw conflict('The sending account is not connected');
    const sample = await prisma.campaignRecipient.findFirst({ where: { campaignId: c.id }, orderBy: { id: 'asc' } });
    const settings = await getSettings();
    const messageId = makeMessageId(account.email);
    const msg = buildMessage({
      campaign: c,
      recipient: { email: req.body.to, token: 'test-preview', vars: sample?.vars || {}, subject: sample?.subject },
      account, owner: req.user, settings: { ...settings, trackingEnabled: false }, messageId,
    });
    msg.to = req.body.to;
    msg.subject = `[TEST] ${msg.subject}`;
    await deliver(account, msg);
    audit(req, 'campaign.test_sent', 'Campaign', c.id, { to: req.body.to });
    res.json({ ok: true });
  }));

// ---------- lifecycle ----------
router.post('/:id/start', validate({ params: idParam, body: z.object({ scheduledAt: z.coerce.date().optional().nullable() }) }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id);
  const settings = await getSettings();
  if (!['DRAFT', 'PENDING_APPROVAL'].includes(c.status)) throw conflict('This campaign has already been started');
  if (req.user.sendingDisabled) throw forbidden('Sending is disabled for your account. Contact your administrator.');
  if (c.type === 'FRESH') {
    const accs = await prisma.emailAccount.findMany({ where: { id: { in: c.accountIds.length ? c.accountIds : [c.accountId] }, ownerId: req.user.id } });
    if (!accs.some(isSendable)) throw conflict('None of the selected sending accounts is connected. Test or reconnect one first.');
  }
  const pending = await prisma.campaignRecipient.count({ where: { campaignId: c.id, status: 'PENDING' } });
  if (!pending) throw conflict('There are no pending recipients');
  const at = req.body.scheduledAt && req.body.scheduledAt > new Date(Date.now() + 60_000) ? req.body.scheduledAt : null;

  let status;
  if (req.user.requireApproval && !c.approvedAt) status = 'PENDING_APPROVAL';
  else status = at ? 'SCHEDULED' : 'SENDING';

  const r = await prisma.campaign.updateMany({
    where: { id: c.id, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } },
    data: {
      status, scheduledAt: at, pausedReason: null,
      ...(status === 'SENDING' ? { startedAt: new Date(), nextSendAt: new Date() } : {}),
    },
  });
  if (!r.count) throw conflict('Campaign state changed; refresh and try again');
  invalidateOwner(req.user.id);
  audit(req, 'campaign.started', 'Campaign', c.id, { status, scheduledAt: at });
  if (status === 'SENDING') wakeWorker();
  res.json({ status, scheduledAt: at, globalPaused: settings.globalSendingPaused });
}));

router.post('/:id/pause', validate({ params: idParam }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id, { id: true });
  const r = await prisma.campaign.updateMany({ where: { id: c.id, status: { in: ['SENDING', 'SCHEDULED'] } }, data: { status: 'PAUSED', pausedReason: 'Paused by you' } });
  if (!r.count) throw conflict('Only sending or scheduled campaigns can be paused');
  invalidateOwner(req.user.id);
  audit(req, 'campaign.paused', 'Campaign', c.id);
  res.json({ status: 'PAUSED' });
}));

router.post('/:id/resume', validate({ params: idParam }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id);
  if (c.status !== 'PAUSED') throw conflict('Only paused campaigns can be resumed');
  if (c.pausedByAdmin) throw forbidden('This campaign was paused by an administrator');
  if (req.user.sendingDisabled) throw forbidden('Sending is disabled for your account');
  if (c.type === 'FRESH') {
    const accs = await prisma.emailAccount.findMany({ where: { id: { in: c.accountIds.length ? c.accountIds : [c.accountId] }, ownerId: req.user.id } });
    if (!accs.some(isSendable)) throw conflict('Reconnect at least one of the selected sending accounts before resuming');
  }
  const status = c.scheduledAt && c.scheduledAt > new Date() && !c.startedAt ? 'SCHEDULED' : 'SENDING';
  await prisma.campaign.updateMany({ where: { id: c.id, status: 'PAUSED' }, data: { status, pausedReason: null, nextSendAt: new Date(), ...(c.startedAt ? {} : { startedAt: new Date() }) } });
  invalidateOwner(req.user.id);
  audit(req, 'campaign.resumed', 'Campaign', c.id);
  wakeWorker();
  res.json({ status });
}));

router.post('/:id/cancel', validate({ params: idParam }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id, { id: true });
  const r = await prisma.campaign.updateMany({
    where: { id: c.id, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'SENDING', 'PAUSED'] } },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  if (!r.count) throw conflict('This campaign cannot be cancelled');
  await prisma.campaignRecipient.updateMany({ where: { campaignId: c.id, status: { in: ['PENDING', 'ON_HOLD'] } }, data: { status: 'SKIPPED', lastError: 'Campaign cancelled' } });
  invalidateOwner(req.user.id);
  audit(req, 'campaign.cancelled', 'Campaign', c.id);
  res.json({ status: 'CANCELLED' });
}));

router.post('/:id/archive', validate({ params: idParam, body: z.object({ archived: z.boolean().default(true) }) }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id);
  if (req.body.archived && !['COMPLETED', 'CANCELLED'].includes(c.status)) throw conflict('Only completed or cancelled campaigns can be archived');
  await prisma.campaign.update({ where: { id: c.id }, data: { archived: req.body.archived } });
  invalidateOwner(req.user.id);
  audit(req, req.body.archived ? 'campaign.archived' : 'campaign.unarchived', 'Campaign', c.id);
  res.json({ archived: req.body.archived });
}));

router.delete('/:id', validate({ params: idParam }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id);
  if (['SENDING'].includes(c.status)) throw conflict('Pause or cancel the campaign before deleting it');
  // Anything that never sent an email can be deleted. Campaigns with send history are kept for auditing — archive them instead.
  const attempts = await prisma.sendAttempt.count({ where: { campaignId: c.id } });
  if (attempts) throw conflict('This campaign has already sent emails, so it is kept for your records. Archive it to hide it.');
  const children = await prisma.campaign.count({ where: { parentId: c.id } });
  if (children) throw conflict('Delete its follow-up campaigns first');
  await prisma.campaign.delete({ where: { id: c.id } });
  invalidateOwner(req.user.id);
  audit(req, 'campaign.deleted', 'Campaign', c.id);
  res.json({ ok: true });
}));

// ---------- recipient management ----------
const idsBody = z.object({ ids: z.array(z.string().max(40)).min(1).max(1000) });

router.post('/:id/recipients/remove', validate({ params: idParam, body: idsBody }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id, { id: true });
  const r = await prisma.campaignRecipient.updateMany({
    where: { campaignId: c.id, id: { in: req.body.ids }, status: { in: ['PENDING', 'ON_HOLD'] } },
    data: { status: 'SKIPPED', lastError: 'Removed by employee' },
  });
  invalidateOwner(req.user.id);
  res.json({ updated: r.count });
}));

router.post('/:id/recipients/hold', validate({ params: idParam, body: idsBody.extend({ action: z.enum(['release', 'skip']) }) }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id, { id: true });
  let updated = 0;
  if (req.body.action === 'skip') {
    updated = (await prisma.campaignRecipient.updateMany({
      where: { campaignId: c.id, id: { in: req.body.ids }, status: 'ON_HOLD' },
      data: { status: 'SKIPPED', lastError: 'Skipped: original account unavailable' },
    })).count;
  } else {
    // Release only recipients whose ORIGINAL account is connected again (never switch sender).
    updated = (await prisma.campaignRecipient.updateMany({
      where: {
        campaignId: c.id, id: { in: req.body.ids }, status: 'ON_HOLD',
        account: { deletedAt: null, adminDisabled: false, status: 'CONNECTED' },
      },
      data: { status: 'PENDING', holdReason: null, nextAttemptAt: new Date() },
    })).count;
    if (updated) wakeWorker();
  }
  invalidateOwner(req.user.id);
  res.json({ updated });
}));

router.post('/:id/recipients/unknown', validate({ params: idParam, body: idsBody.extend({ action: z.enum(['mark_sent', 'mark_failed', 'retry']) }) }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id, { id: true, status: true });
  const where = { campaignId: c.id, id: { in: req.body.ids }, status: 'UNKNOWN' };
  const data = {
    mark_sent: { status: 'SENT', sentAt: new Date(), holdReason: null, lastError: 'Marked as sent by employee' },
    mark_failed: { status: 'FAILED', holdReason: null, lastError: 'Marked as failed by employee' },
    retry: { status: 'PENDING', holdReason: null, nextAttemptAt: new Date(), lastError: 'Retry confirmed by employee (duplicate risk accepted)' },
  }[req.body.action];
  const r = await prisma.campaignRecipient.updateMany({ where, data });
  if (req.body.action === 'retry' && r.count && ['COMPLETED'].includes(c.status)) {
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'SENDING', completedAt: null, nextSendAt: new Date() } });
  }
  if (req.body.action === 'retry') wakeWorker();
  invalidateOwner(req.user.id);
  audit(req, `recipient.unknown_${req.body.action}`, 'Campaign', c.id, { count: r.count });
  res.json({ updated: r.count });
}));

router.post('/:id/recipients/retry-failed', validate({ params: idParam, body: idsBody }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id, { id: true, status: true });
  // Only transient-class failures are eligible. Bounces / invalid / suppressed are never retried.
  const r = await prisma.campaignRecipient.updateMany({
    where: { campaignId: c.id, id: { in: req.body.ids }, status: 'FAILED', lastError: { startsWith: 'TRANSIENT' } },
    data: { status: 'PENDING', nextAttemptAt: new Date() },
  });
  if (r.count && c.status === 'COMPLETED') {
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'SENDING', completedAt: null, nextSendAt: new Date() } });
  }
  if (r.count) wakeWorker();
  invalidateOwner(req.user.id);
  res.json({ updated: r.count });
}));

// ---------- follow-ups ----------
const FOLLOWUP_ELIGIBLE = {
  status: 'SENT', repliedAt: null, unsubscribedAt: null, bouncedAt: null, messageId: { not: null },
};

router.get('/:id/follow-up/eligible', validate({ params: idParam, query: pagination }), ah(async (req, res) => {
  const c = await ownedCampaign(req, req.params.id, { id: true });
  const { page, pageSize } = req.query;
  const where = { campaignId: c.id, ...FOLLOWUP_ELIGIBLE };
  const [items, total, excluded] = await Promise.all([
    prisma.campaignRecipient.findMany({
      where,
      select: { id: true, email: true, sentAt: true, openedAt: true, clickedAt: true, account: { select: { id: true, email: true, status: true, deletedAt: true, adminDisabled: true } } },
      orderBy: { id: 'asc' }, skip: (page - 1) * pageSize, take: pageSize,
    }),
    prisma.campaignRecipient.count({ where }),
    prisma.campaignRecipient.count({ where: { campaignId: c.id, OR: [{ repliedAt: { not: null } }, { unsubscribedAt: { not: null } }, { status: 'BOUNCED' }] } }),
  ]);
  res.json({ items, total, page, pageSize, excluded });
}));

const followUpSchema = z.object({
  name: z.string().trim().min(1).max(150),
  hourlyRate: z.coerce.number().int().min(1).max(3600).default(30),
  keepThreadSubject: z.boolean().default(true),
  includeIds: z.array(z.string().max(40)).max(MAX_RECIPIENTS_PER_CAMPAIGN).optional(),
  excludeIds: z.array(z.string().max(40)).max(MAX_RECIPIENTS_PER_CAMPAIGN).optional(),
  ...contentFields,
});

router.post('/:id/follow-up', validate({ params: idParam, body: followUpSchema }), ah(async (req, res) => {
  const parent = await ownedCampaign(req, req.params.id);
  if (!['SENDING', 'PAUSED', 'COMPLETED', 'CANCELLED'].includes(parent.status)) throw conflict('Follow-ups can be created once the campaign has sent emails');
  const settings = await getSettings();
  const b = req.body;
  const content = await resolveContent(req, b);

  const result = await prisma.$transaction(async (tx) => {
    await lockCampaigns(tx, req.user.id);
    const working = await workingCampaignCount(tx, req.user.id);
    if (working >= settings.maxWorkingCampaigns) throw conflict(`Working campaign limit (${settings.maxWorkingCampaigns}) reached. Archive a finished campaign first.`, 'CAMPAIGN_LIMIT');
    const campaign = await tx.campaign.create({
      data: { ownerId: req.user.id, name: b.name, type: 'FOLLOWUP', parentId: parent.id, hourlyRate: b.hourlyRate, accountId: null, accountIds: [], ...content },
    });
    let cursor = null; let inserted = 0; let suppressed = 0;
    const include = b.includeIds?.length ? new Set(b.includeIds) : null;
    const exclude = new Set(b.excludeIds || []);
    for (;;) {
      const page = await tx.campaignRecipient.findMany({
        where: { campaignId: parent.id, ...FOLLOWUP_ELIGIBLE },
        select: { id: true, email: true, accountId: true, messageId: true, references: true, vars: true, subject: true },
        orderBy: { id: 'asc' }, take: 1000, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!page.length) break;
      cursor = page[page.length - 1].id;
      const picked = page.filter((r) => (!include || include.has(r.id)) && !exclude.has(r.id));
      const supp = new Set((await tx.suppression.findMany({
        where: { email: { in: picked.map((p) => p.email) }, scopeKey: { in: ['global', req.user.id] } }, select: { email: true },
      })).map((s) => s.email));
      suppressed += supp.size;
      const parentSubject = (r) => r.subject || parent.subject;
      const data = picked.filter((r) => !supp.has(r.email)).map((r) => ({
        campaignId: campaign.id,
        parentId: r.id,
        email: r.email,
        accountId: r.accountId, // ALWAYS the original sender mailbox
        vars: r.vars ?? undefined,
        token: randomToken(18),
        inReplyTo: r.messageId,
        references: [r.references, r.messageId].filter(Boolean).join(' ').slice(-2000),
        subject: b.keepThreadSubject ? (/^re:/i.test(parentSubject(r)) ? parentSubject(r) : `Re: ${parentSubject(r)}`) : null,
      }));
      if (data.length) inserted += (await tx.campaignRecipient.createMany({ data, skipDuplicates: true })).count;
      if (page.length < 1000) break;
    }
    if (!inserted) throw badRequest('No eligible recipients selected (replied, unsubscribed and bounced recipients are excluded automatically)');
    return { campaign, inserted, suppressed };
  }, { timeout: 60_000, maxWait: 10_000 });

  invalidateOwner(req.user.id);
  audit(req, 'campaign.followup_created', 'Campaign', result.campaign.id, { parentId: parent.id, recipients: result.inserted });
  res.status(201).json({ campaign: result.campaign, recipients: { inserted: result.inserted, suppressed: result.suppressed } });
}));

export { WORKING_STATUSES };
export default router;