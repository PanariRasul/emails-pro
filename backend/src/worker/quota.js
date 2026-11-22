import { prisma } from '../lib/prisma.js';
import { dayWindow, hourWindow, intervalMs } from '../services/limits.js';

export class QuotaError extends Error {
  constructor(kind) {
    super(`quota:${kind}`);
    this.kind = kind; // SLOT | HOUR | DAY | EMP_DAY
  }
}

async function bump(tx, scope, windowStart, limit) {
  if (!Number.isFinite(limit)) return true;
  if (limit <= 0) return false;
  const rows = await tx.$queryRaw`
    INSERT INTO "UsageCounter" ("scope", "windowStart", "count")
    VALUES (${scope}, ${windowStart}, 1)
    ON CONFLICT ("scope", "windowStart")
    DO UPDATE SET "count" = "UsageCounter"."count" + 1
    WHERE "UsageCounter"."count" < ${limit}
    RETURNING "count"`;
  return rows.length > 0;
}

/**
 * Atomically reserve one send for an account:
 *  1. take the account's shared pacing slot (one slot per interval across ALL campaigns)
 *  2. increment hourly, daily and employee-daily counters if under their limits
 * Everything happens in one transaction, so concurrent workers can never exceed a limit.
 */
export async function reserveSend({ accountId, ownerId, limits, now = new Date() }) {
  const gapMs = intervalMs(limits.hourly);
  if (!Number.isFinite(gapMs)) throw new QuotaError('HOUR');
  const next = new Date(now.getTime() + gapMs);
  return prisma.$transaction(async (tx) => {
    const slot = await tx.$queryRaw`
      UPDATE "EmailAccount"
      SET "nextSendAt" = ${next}
      WHERE "id" = ${accountId} AND ("nextSendAt" IS NULL OR "nextSendAt" <= ${now})
      RETURNING "id"`;
    if (!slot.length) throw new QuotaError('SLOT');
    if (!(await bump(tx, `acct:${accountId}:hour`, hourWindow(now), limits.hourly))) throw new QuotaError('HOUR');
    if (!(await bump(tx, `acct:${accountId}:day`, dayWindow(now), limits.daily))) throw new QuotaError('DAY');
    if (!(await bump(tx, `emp:${ownerId}:day`, dayWindow(now), limits.employeeDaily))) throw new QuotaError('EMP_DAY');
    return true;
  }, { timeout: 10_000 });
}

/** Give a reservation back (send never happened). Floors at zero. */
export async function releaseSend({ accountId, ownerId, now = new Date() }) {
  const pairs = [
    [`acct:${accountId}:hour`, hourWindow(now)],
    [`acct:${accountId}:day`, dayWindow(now)],
    [`emp:${ownerId}:day`, dayWindow(now)],
  ];
  for (const [scope, w] of pairs) {
    await prisma.$executeRaw`UPDATE "UsageCounter" SET "count" = GREATEST(0, "count" - 1) WHERE "scope" = ${scope} AND "windowStart" = ${w}`;
  }
}

export function nextWindowStart(kind, now = new Date()) {
  if (kind === 'HOUR') return new Date(hourWindow(now).getTime() + 3_600_000);
  return new Date(dayWindow(now).getTime() + 86_400_000);
}
