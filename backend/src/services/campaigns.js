import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { caches } from '../lib/cache.js';
import { randomToken } from '../lib/crypto.js';

export const WORKING_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'SENDING', 'PAUSED'];
export const MAX_RECIPIENTS_PER_CAMPAIGN = 20_000;

const EMPTY = {
  total: 0, pending: 0, sending: 0, sent: 0, failed: 0, bounced: 0, unknown: 0, onHold: 0, skipped: 0, suppressed: 0,
  opened: 0, clicked: 0, replied: 0, unsubscribed: 0,
};

/** One aggregate query for many campaigns (avoids N+1). */
export async function statsFor(campaignIds) {
  const out = new Map(campaignIds.map((id) => [id, { ...EMPTY }]));
  if (!campaignIds.length) return out;
  const rows = await prisma.$queryRaw`
    SELECT "campaignId",
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
      count(*) FILTER (WHERE status = 'SENDING')::int AS sending,
      count(*) FILTER (WHERE status = 'SENT')::int AS sent,
      count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
      count(*) FILTER (WHERE status = 'BOUNCED')::int AS bounced,
      count(*) FILTER (WHERE status = 'UNKNOWN')::int AS unknown,
      count(*) FILTER (WHERE status = 'ON_HOLD')::int AS "onHold",
      count(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped,
      count(*) FILTER (WHERE status = 'SUPPRESSED')::int AS suppressed,
      count("openedAt")::int AS opened,
      count("clickedAt")::int AS clicked,
      count("repliedAt")::int AS replied,
      count("unsubscribedAt")::int AS unsubscribed
    FROM "CampaignRecipient"
    WHERE "campaignId" IN (${Prisma.join(campaignIds)})
    GROUP BY "campaignId"`;
  for (const r of rows) {
    const { campaignId, ...rest } = r;
    out.set(campaignId, rest);
  }
  for (const s of out.values()) {
    const finished = s.sent + s.failed + s.bounced + s.unknown + s.skipped + s.suppressed;
    s.completion = s.total ? Math.round((finished / s.total) * 1000) / 10 : 0;
  }
  return out;
}

export async function cachedStats(ownerId, campaignId) {
  return caches.stats.wrap(`emp:${ownerId}:c:${campaignId}`, async () => (await statsFor([campaignId])).get(campaignId), 15_000);
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s);

/**
 * Snapshot contacts from lists into campaign recipients, excluding suppressed addresses and duplicates.
 * Contacts are read with a cursor in pages (never loads the whole list into memory).
 */
export async function snapshotRecipients(tx, { campaignId, ownerId, listIds }) {
  let cursor = null;
  let inserted = 0;
  let suppressedCount = 0;
  const seen = new Set();
  for (;;) {
    const page = await tx.contact.findMany({
      where: { listId: { in: listIds }, ownerId },
      select: { id: true, email: true, firstName: true, lastName: true, company: true, fields: true },
      orderBy: { id: 'asc' },
      take: 1000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (!page.length) break;
    cursor = page[page.length - 1].id;
    const fresh = page.filter((c) => !seen.has(c.email));
    fresh.forEach((c) => seen.add(c.email));
    if (seen.size > MAX_RECIPIENTS_PER_CAMPAIGN) {
      const e = new Error(`A campaign can have at most ${MAX_RECIPIENTS_PER_CAMPAIGN} recipients`);
      e.status = 400;
      throw e;
    }
    const suppressed = new Set((await tx.suppression.findMany({
      where: { email: { in: fresh.map((c) => c.email) }, scopeKey: { in: ['global', ownerId] } },
      select: { email: true },
    })).map((s) => s.email));
    suppressedCount += suppressed.size;
    const data = fresh.filter((c) => !suppressed.has(c.email)).map((c) => ({
      campaignId,
      contactId: c.id,
      email: c.email,
      token: randomToken(18),
      vars: { ...(c.fields && typeof c.fields === 'object' ? c.fields : {}), firstName: c.firstName ?? '', lastName: c.lastName ?? '', company: c.company ?? '', companyName: c.company ?? '' },
    }));
    if (data.length) {
      const r = await tx.campaignRecipient.createMany({ data, skipDuplicates: true });
      inserted += r.count;
    }
    if (page.length < 1000) break;
  }
  return { inserted, suppressed: suppressedCount };
}

export async function workingCampaignCount(tx, ownerId) {
  return tx.campaign.count({ where: { ownerId, archived: false, status: { in: WORKING_STATUSES } } });
}

export async function lockCampaigns(tx, ownerId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`campaigns:${ownerId}`}))`;
}
