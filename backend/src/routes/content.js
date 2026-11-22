// Pitches (templates), recipient lists/contacts and suppression list — all employee-owned.
import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { invalidateOwner } from '../lib/cache.js';
import { ah, badRequest, conflict, notFound } from '../lib/errors.js';
import { idParam, pagination, validate } from '../middleware/common.js';
import { employeeOnly } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { buildVars, htmlToText, renderTemplate, sanitizeEmailHtml } from '../services/template.js';
import { isEmail } from '../services/campaigns.js';

// ======================= Pitches =======================
export const pitchesRouter = Router();
pitchesRouter.use(employeeOnly);

const pitchBody = z.object({
  name: z.string().trim().min(1).max(150),
  subjects: z.array(z.string().trim().min(1).max(250)).min(1).max(10),
  html: z.string().min(1).max(200_000),
  text: z.string().max(100_000).optional(),
});

const latestVersion = { versions: { orderBy: { version: 'desc' }, take: 1 } };

pitchesRouter.get('/', ah(async (req, res) => {
  const pitches = await prisma.pitch.findMany({
    where: { ownerId: req.user.id, archived: false },
    include: { ...latestVersion, _count: { select: { versions: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  const ids = pitches.map((p) => p.id);
  const usage = ids.length ? await prisma.campaign.groupBy({ by: ['pitchVersionId'], where: { pitchVersion: { pitchId: { in: ids } } }, _count: { _all: true } }) : [];
  const versionToPitch = new Map((await prisma.pitchVersion.findMany({ where: { pitchId: { in: ids } }, select: { id: true, pitchId: true } })).map((v) => [v.id, v.pitchId]));
  const used = new Map();
  for (const u of usage) {
    const pid = versionToPitch.get(u.pitchVersionId);
    used.set(pid, (used.get(pid) || 0) + u._count._all);
  }
  res.json({ pitches: pitches.map((p) => ({ ...p, latest: p.versions[0], versions: undefined, campaignsUsing: used.get(p.id) || 0 })) });
}));

pitchesRouter.get('/:id', validate({ params: idParam }), ah(async (req, res) => {
  const pitch = await prisma.pitch.findFirst({
    where: { id: req.params.id, ownerId: req.user.id },
    include: { versions: { orderBy: { version: 'desc' }, take: 20, include: { campaigns: { select: { id: true, name: true, status: true } } } } },
  });
  if (!pitch) throw notFound('Pitch');
  res.json({ pitch });
}));

function cleanPitch(b) {
  const html = sanitizeEmailHtml(b.html);
  return { subjects: b.subjects, html, text: b.text?.trim() || htmlToText(html) };
}

pitchesRouter.post('/', validate({ body: pitchBody }), ah(async (req, res) => {
  const pitch = await prisma.pitch.create({
    data: { ownerId: req.user.id, name: req.body.name, versions: { create: { version: 1, ...cleanPitch(req.body) } } },
    include: latestVersion,
  });
  audit(req, 'pitch.created', 'Pitch', pitch.id);
  res.status(201).json({ pitch: { ...pitch, latest: pitch.versions[0] } });
}));

// Editing creates a NEW immutable version, so campaigns that used older versions keep their history.
pitchesRouter.put('/:id', validate({ params: idParam, body: pitchBody }), ah(async (req, res) => {
  const pitch = await prisma.pitch.findFirst({ where: { id: req.params.id, ownerId: req.user.id }, include: latestVersion });
  if (!pitch) throw notFound('Pitch');
  const nextVersion = (pitch.versions[0]?.version || 0) + 1;
  const updated = await prisma.pitch.update({
    where: { id: pitch.id },
    data: { name: req.body.name, versions: { create: { version: nextVersion, ...cleanPitch(req.body) } } },
    include: latestVersion,
  });
  audit(req, 'pitch.versioned', 'Pitch', pitch.id, { version: nextVersion });
  res.json({ pitch: { ...updated, latest: updated.versions[0] } });
}));

pitchesRouter.post('/:id/duplicate', validate({ params: idParam }), ah(async (req, res) => {
  const pitch = await prisma.pitch.findFirst({ where: { id: req.params.id, ownerId: req.user.id }, include: latestVersion });
  if (!pitch) throw notFound('Pitch');
  const v = pitch.versions[0];
  const copy = await prisma.pitch.create({
    data: { ownerId: req.user.id, name: `${pitch.name} (copy)`.slice(0, 150), versions: { create: { version: 1, subjects: v.subjects, html: v.html, text: v.text } } },
    include: latestVersion,
  });
  res.status(201).json({ pitch: { ...copy, latest: copy.versions[0] } });
}));

// Delete: removed completely if no campaign ever used it; otherwise hidden (campaign history keeps its exact content).
pitchesRouter.delete('/:id', validate({ params: idParam }), ah(async (req, res) => {
  const pitch = await prisma.pitch.findFirst({ where: { id: req.params.id, ownerId: req.user.id }, select: { id: true, name: true } });
  if (!pitch) throw notFound('Pitch');
  const used = await prisma.campaign.count({ where: { pitchVersion: { pitchId: pitch.id } } });
  if (used) {
    await prisma.pitch.update({ where: { id: pitch.id }, data: { archived: true } });
    audit(req, 'pitch.archived', 'Pitch', pitch.id);
    return res.json({ ok: true, deleted: false, archived: true, message: `Removed from your pitches. It was used in ${used} campaign(s), so those campaigns keep their copy.` });
  }
  await prisma.pitch.delete({ where: { id: pitch.id } });
  audit(req, 'pitch.deleted', 'Pitch', pitch.id, { name: pitch.name });
  return res.json({ ok: true, deleted: true });
}));

pitchesRouter.post('/preview', validate({ body: z.object({ subject: z.string().max(250), html: z.string().max(200_000), vars: z.record(z.string(), z.string().max(500)).optional() }) }), ah(async (req, res) => {
  const vars = buildVars({
    // With explicit sample data (e.g. the first pasted recipient) preview exactly that person, including name guessing.
    recipient: req.body.vars
      ? { email: (req.body.vars.email && isEmail(req.body.vars.email)) ? req.body.vars.email : 'info@example.com', vars: req.body.vars }
      : { email: 'jane@example.com', vars: { firstName: 'Jane', lastName: 'Doe', company: 'Example Co' } },
    owner: req.user,
    account: null,
  });
  const html = renderTemplate(sanitizeEmailHtml(req.body.html), vars, { html: true });
  res.json({ subject: renderTemplate(req.body.subject, vars), html, text: htmlToText(html) });
}));

// ======================= Lists & contacts =======================
export const listsRouter = Router();
listsRouter.use(employeeOnly);

listsRouter.get('/', ah(async (req, res) => {
  const lists = await prisma.recipientList.findMany({
    where: { ownerId: req.user.id },
    include: { _count: { select: { contacts: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ lists: lists.map((l) => ({ id: l.id, name: l.name, source: l.source, createdAt: l.createdAt, contacts: l._count.contacts })) });
}));

listsRouter.post('/', validate({ body: z.object({ name: z.string().trim().min(1).max(150), source: z.string().trim().max(200).optional() }) }), ah(async (req, res) => {
  const list = await prisma.recipientList.create({ data: { ownerId: req.user.id, name: req.body.name, source: req.body.source } });
  res.status(201).json({ list });
}));

async function ownedList(req, id) {
  const l = await prisma.recipientList.findFirst({ where: { id, ownerId: req.user.id } });
  if (!l) throw notFound('List');
  return l;
}

listsRouter.get('/:id/contacts', validate({ params: idParam, query: pagination.extend({ search: z.string().max(200).optional() }) }), ah(async (req, res) => {
  await ownedList(req, req.params.id);
  const { page, pageSize, search } = req.query;
  const where = { listId: req.params.id, ...(search ? { OR: [{ email: { contains: search.toLowerCase() } }, { company: { contains: search, mode: 'insensitive' } }] } : {}) };
  const [items, total] = await Promise.all([
    prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.contact.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
}));

const contactRow = z.object({
  email: z.string().trim().toLowerCase().max(254),
  firstName: z.string().trim().max(100).optional().nullable(),
  lastName: z.string().trim().max(100).optional().nullable(),
  company: z.string().trim().max(200).optional().nullable(),
  fields: z.record(z.string().max(50), z.string().max(500)).optional().nullable(),
});

// Imports arrive in batches (the frontend parses CSV and posts ≤1000 rows per request).
listsRouter.post('/:id/contacts', validate({
  params: idParam,
  body: z.object({ contacts: z.array(contactRow).min(1).max(1000), consentSource: z.string().trim().max(200).optional() }),
}), ah(async (req, res) => {
  const list = await ownedList(req, req.params.id);
  const total = await prisma.contact.count({ where: { ownerId: req.user.id } });
  if (total + req.body.contacts.length > 100_000) throw conflict('Contact storage limit (100,000) reached. Remove old lists first.');
  const seen = new Set();
  const valid = [];
  let invalid = 0; let dupInBatch = 0;
  for (const c of req.body.contacts) {
    if (!isEmail(c.email)) { invalid += 1; continue; }
    if (seen.has(c.email)) { dupInBatch += 1; continue; }
    seen.add(c.email);
    valid.push({
      ownerId: req.user.id, listId: list.id, email: c.email,
      firstName: c.firstName || null, lastName: c.lastName || null, company: c.company || null,
      fields: c.fields || undefined, consentSource: req.body.consentSource || list.source || null,
    });
  }
  const r = valid.length ? await prisma.contact.createMany({ data: valid, skipDuplicates: true }) : { count: 0 };
  const suppressed = valid.length ? await prisma.suppression.count({ where: { email: { in: valid.map((v) => v.email) }, scopeKey: { in: ['global', req.user.id] } } }) : 0;
  res.json({ added: r.count, duplicates: dupInBatch + (valid.length - r.count), invalid, suppressed });
}));

listsRouter.patch('/:id', validate({ params: idParam, body: z.object({ name: z.string().trim().min(1).max(150).optional(), source: z.string().trim().max(200).nullable().optional() }) }), ah(async (req, res) => {
  await ownedList(req, req.params.id);
  const list = await prisma.recipientList.update({ where: { id: req.params.id }, data: req.body });
  res.json({ list });
}));

// Edit one contact (name / company / custom fields). Campaigns already created keep the values they were created with.
listsRouter.patch('/:id/contacts/:contactId', validate({
  params: z.object({ id: z.string().max(40), contactId: z.string().max(40) }),
  body: z.object({
    firstName: z.string().trim().max(100).nullable().optional(), lastName: z.string().trim().max(100).nullable().optional(),
    company: z.string().trim().max(200).nullable().optional(), fields: z.record(z.string().max(50), z.string().max(500)).nullable().optional(),
  }),
}), ah(async (req, res) => {
  await ownedList(req, req.params.id);
  const c = await prisma.contact.findFirst({ where: { id: req.params.contactId, listId: req.params.id } });
  if (!c) throw notFound('Contact');
  const data = Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, v === '' ? null : v]));
  if (data.fields === null) data.fields = Prisma.DbNull;
  const contact = await prisma.contact.update({ where: { id: c.id }, data });
  res.json({ contact });
}));

listsRouter.post('/:id/contacts/delete', validate({ params: idParam, body: z.object({ ids: z.array(z.string().max(40)).min(1).max(1000) }) }), ah(async (req, res) => {
  await ownedList(req, req.params.id);
  const r = await prisma.contact.deleteMany({ where: { id: { in: req.body.ids }, listId: req.params.id } });
  res.json({ deleted: r.count });
}));

listsRouter.delete('/:id/contacts/:contactId', validate({ params: z.object({ id: z.string().max(40), contactId: z.string().max(40) }) }), ah(async (req, res) => {
  await ownedList(req, req.params.id);
  await prisma.contact.deleteMany({ where: { id: req.params.contactId, listId: req.params.id } });
  res.json({ ok: true });
}));

listsRouter.delete('/:id', validate({ params: idParam }), ah(async (req, res) => {
  const list = await ownedList(req, req.params.id);
  // Campaign recipients are snapshots, so deleting a list never alters campaign history.
  await prisma.recipientList.delete({ where: { id: list.id } });
  audit(req, 'list.deleted', 'RecipientList', list.id);
  res.json({ ok: true });
}));

// ======================= Suppressions =======================
export const suppressionsRouter = Router();
suppressionsRouter.use(employeeOnly);

suppressionsRouter.get('/', validate({ query: pagination.extend({ search: z.string().max(200).optional() }) }), ah(async (req, res) => {
  const { page, pageSize, search } = req.query;
  const uid = req.user.id;
  const like = `%${(search || '').toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;
  // Employees see their manual entries plus global suppressions for addresses in their own contacts/campaigns.
  const filter = Prisma.sql`
    FROM "Suppression" s
    WHERE s."email" LIKE ${like} AND (
      s."scopeKey" = ${uid}
      OR (s."scopeKey" = 'global' AND (
        EXISTS (SELECT 1 FROM "Contact" c WHERE c."ownerId" = ${uid} AND c."email" = s."email")
        OR EXISTS (SELECT 1 FROM "CampaignRecipient" r JOIN "Campaign" k ON k."id" = r."campaignId" WHERE k."ownerId" = ${uid} AND r."email" = s."email")
      ))
    )`;
  const [items, [{ total }]] = await Promise.all([
    prisma.$queryRaw`SELECT s.* ${filter} ORDER BY s."createdAt" DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.$queryRaw`SELECT count(*)::int AS total ${filter}`,
  ]);
  res.json({ items: items.map((s) => ({ ...s, manual: s.scopeKey === uid })), total, page, pageSize });
}));

suppressionsRouter.post('/', validate({ body: z.object({ emails: z.array(z.string().trim().toLowerCase().max(254)).min(1).max(1000) }) }), ah(async (req, res) => {
  const emails = [...new Set(req.body.emails.filter(isEmail))];
  if (!emails.length) throw badRequest('No valid email addresses');
  const r = await prisma.suppression.createMany({
    data: emails.map((email) => ({ scopeKey: req.user.id, email, reason: 'MANUAL', source: 'employee' })),
    skipDuplicates: true,
  });
  invalidateOwner(req.user.id);
  audit(req, 'suppression.added', 'Suppression', null, { count: r.count });
  res.json({ added: r.count });
}));

suppressionsRouter.delete('/:id', validate({ params: idParam }), ah(async (req, res) => {
  // Only manual, employee-scoped entries can be removed. Unsubscribes/bounces/complaints are permanent.
  const r = await prisma.suppression.deleteMany({ where: { id: req.params.id, scopeKey: req.user.id, reason: 'MANUAL' } });
  if (!r.count) throw notFound('Suppression');
  res.json({ ok: true });
}));