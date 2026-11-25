// Estimated completion time for a campaign.
// Simulates sending hour by hour with the same limits the sender enforces: campaign speed, each mailbox's
// hourly and daily limits (including warm-up growth day by day), the employee's combined daily total,
// and other campaigns sharing the same mailboxes. It is an estimate: replies, failures, pauses and a
// sleeping server (Render Free / Vercel without a scheduler) can make the real finish later.
import { prisma } from "../lib/prisma.js";
import { accountLimits, dayWindow, hourWindow } from "./limits.js";

const HOUR = 3_600_000;
const MAX_HOURS = 24 * 120; // give up after ~4 months
const OPEN_STATUSES = ["PENDING", "SENDING"];
const ACTIVE_CAMPAIGN = ["SENDING", "SCHEDULED", "PAUSED"];

const sendable = (a) =>
  a && !a.deletedAt && !a.adminDisabled && a.status === "CONNECTED";

async function counter(scope, windowStart) {
  const row = await prisma.usageCounter.findUnique({
    where: { scope_windowStart: { scope, windowStart } },
  });
  return row?.count ?? 0;
}

/**
 * Pure simulation (exported for tests).
 *  mailboxes: [{ pending, account, rate, share, usedHour, usedDay }]
 *  employee:  { usedDay }
 */
export function simulate({
  start,
  mailboxes,
  owner,
  settings,
  employeeUsedDay = 0,
}) {
  const left = mailboxes.map((m) => m.pending);
  let total = left.reduce((a, b) => a + b, 0);
  if (!total) return { finishAt: start, hours: 0, limitedBy: null };
  let t = start.getTime();
  let dayStart = dayWindow(new Date(t)).getTime();
  const usedDay = mailboxes.map((m) => m.usedDay || 0);
  let empUsed = employeeUsedDay;
  const reasons = { speed: 0, daily: 0, employee: 0 };

  for (let step = 0; step < MAX_HOURS; step += 1) {
    const now = new Date(t);
    const hourEnd = hourWindow(now).getTime() + HOUR;
    const fraction = (hourEnd - t) / HOUR; // first step may be a partial hour
    const thisDay = dayWindow(now).getTime();
    if (thisDay !== dayStart) {
      dayStart = thisDay;
      usedDay.fill(0);
      empUsed = 0;
    }
    const limits0 = accountLimits(
      mailboxes[0]?.account || {},
      owner,
      settings,
      now,
    );
    let empLeft = Math.max(0, limits0.employeeDaily - empUsed);
    let lastFinish = t;
    mailboxes.forEach((m, i) => {
      if (!left[i]) return;
      const lim = accountLimits(m.account, owner, settings, now);
      const perHour = Math.max(
        1,
        Math.floor(Math.min(m.rate, lim.hourly) / Math.max(1, m.share)),
      );
      const hourCap = Math.max(
        0,
        Math.floor(perHour * fraction) - (step === 0 ? m.usedHour || 0 : 0),
      );
      const dayCap = Math.max(0, lim.daily - usedDay[i]);
      const n = Math.min(left[i], hourCap, dayCap, empLeft);
      if (n < left[i]) {
        if (n === empLeft && empLeft < Math.min(hourCap, dayCap))
          reasons.employee += 1;
        else if (n === dayCap && dayCap < hourCap) reasons.daily += 1;
        else reasons.speed += 1;
      }
      left[i] -= n;
      usedDay[i] += n;
      empLeft -= n;
      empUsed += n;
      total -= n;
      if (n > 0) lastFinish = Math.max(lastFinish, t + (n / perHour) * HOUR);
    });
    if (total <= 0) {
      const finishAt = new Date(Math.min(lastFinish, hourEnd));
      const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
      return {
        finishAt,
        hours: Math.round(((finishAt - start) / HOUR) * 10) / 10,
        limitedBy: top[1] ? top[0] : "speed",
      };
    }
    t = hourEnd;
  }
  return { finishAt: null, hours: null, limitedBy: "too-long" };
}

/** Estimate for one campaign. Returns { startedAt, finishAt, hours, pending, note, limitedBy }. */
export async function campaignEta(c, owner, settings, now = new Date()) {
  const base = {
    startedAt: c.startedAt,
    scheduledAt: c.scheduledAt,
    completedAt: c.completedAt,
  };
  if (c.status === "COMPLETED" || c.status === "CANCELLED")
    return { ...base, finishAt: c.completedAt, done: true };
  const groups = await prisma.campaignRecipient.groupBy({
    by: ["accountId"],
    where: { campaignId: c.id, status: { in: OPEN_STATUSES } },
    _count: { _all: true },
  });
  const pending = groups.reduce((s, g) => s + g._count._all, 0);
  if (!pending)
    return {
      ...base,
      pending: 0,
      finishAt: c.status === "SENDING" ? now : null,
      note: c.status === "SENDING" ? "Finishing the last emails." : null,
    };
  if (c.status === "PAUSED")
    return {
      ...base,
      pending,
      finishAt: null,
      note: "Paused — resume the campaign to get an estimate.",
    };
  if (settings.globalSendingPaused)
    return {
      ...base,
      pending,
      finishAt: null,
      note: "Sending is paused by the administrator.",
    };

  // Recipients not yet assigned to a mailbox are split evenly over the campaign's mailboxes.
  const ids = [
    ...new Set([
      ...(c.accountIds?.length ? c.accountIds : [c.accountId].filter(Boolean)),
      ...groups.map((g) => g.accountId).filter(Boolean),
    ]),
  ];
  const accounts = await prisma.emailAccount.findMany({
    where: { id: { in: ids } },
  });
  const usable = accounts.filter(sendable);
  if (!usable.length)
    return {
      ...base,
      pending,
      finishAt: null,
      note: "No connected sending account — reconnect one to continue.",
    };
  const unassigned = groups.find((g) => !g.accountId)?._count._all ?? 0;
  const byAcc = new Map(
    groups.filter((g) => g.accountId).map((g) => [g.accountId, g._count._all]),
  );
  let stuck = 0;
  for (const [id, n] of byAcc)
    if (!usable.some((a) => a.id === id)) {
      stuck += n;
      byAcc.delete(id);
    }
  // Fresh campaigns move unsent emails to the other mailboxes; follow-ups wait for their original sender.
  const spread = unassigned + (c.type === "FRESH" ? stuck : 0);
  usable.forEach((a, i) =>
    byAcc.set(
      a.id,
      (byAcc.get(a.id) || 0) +
        Math.floor(spread / usable.length) +
        (i < spread % usable.length ? 1 : 0),
    ),
  );

  // How many other active campaigns share each mailbox (they share its speed).
  const shares = await prisma.campaignRecipient.groupBy({
    by: ["accountId", "campaignId"],
    where: {
      accountId: { in: usable.map((a) => a.id) },
      status: { in: OPEN_STATUSES },
      campaign: { status: { in: ACTIVE_CAMPAIGN }, id: { not: c.id } },
    },
  });
  const start =
    c.status === "SCHEDULED" && c.scheduledAt && new Date(c.scheduledAt) > now
      ? new Date(c.scheduledAt)
      : now;
  const mailboxes = [];
  for (const a of usable) {
    const n = byAcc.get(a.id) || 0;
    if (!n) continue;
    mailboxes.push({
      account: a,
      pending: n,
      rate: c.hourlyRate,
      share: 1 + shares.filter((s) => s.accountId === a.id).length,
      usedHour:
        start === now ? await counter(`acct:${a.id}:hour`, hourWindow(now)) : 0,
      usedDay:
        dayWindow(start).getTime() === dayWindow(now).getTime()
          ? await counter(`acct:${a.id}:day`, dayWindow(now))
          : 0,
    });
  }
  const employeeUsedDay =
    dayWindow(start).getTime() === dayWindow(now).getTime()
      ? await counter(`emp:${owner.id}:day`, dayWindow(now))
      : 0;
  const sim = simulate({ start, mailboxes, owner, settings, employeeUsedDay });
  const onHold = c.type === "FOLLOWUP" ? stuck : 0;
  return {
    ...base,
    pending,
    ...sim,
    note: onHold
      ? `${onHold} follow-up email(s) wait for their original sender to be reconnected and are not included.`
      : null,
  };
}
