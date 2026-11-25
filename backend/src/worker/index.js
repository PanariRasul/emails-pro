// In-process background worker for Render Free (no separate paid worker service).
// Safety properties:
//  - Lease row in PostgreSQL => only one active scheduler/sender even during deploy overlap.
//  - All state lives in PostgreSQL; on wake/restart the worker recovers and continues.
//  - Adaptive sleep: short ticks only while campaigns are sending; long idle ticks otherwise.
import { config } from "../config/index.js";
import { prisma, isTransientDbError } from "../lib/prisma.js";
import { waitUntil } from "@vercel/functions";
import { logger } from "../lib/logger.js";
import { getSettings } from "../services/settings.js";
import { closeAllTransports } from "../services/smtp.js";
import { sendTick } from "./sender.js";
import {
  accountHealthTick,
  cleanupTick,
  imapTick,
  reconcileUnknown,
  recoverStuck,
  schedulerTick,
} from "./maintenance.js";
import { healthTick, recordWake } from "./health.js";

const LEASE_ID = "primary";
const LEASE_MS = 90_000;

const state = {
  enabled: config.runWorker,
  running: false,
  leader: false,
  startedAt: null,
  lastTickAt: null,
  lastSendTickAt: null,
  lastError: null,
  activeCampaigns: 0,
  sentThisProcess: 0,
  consecutiveErrors: 0,
};
const timers = {
  scheduler: 0,
  imap: 0,
  maintenance: 0,
  health: 0,
  cleanup: 0,
  lease: 0,
};

let wakeResolve = null;
let loopPromise = null;

export function workerState() {
  return {
    ...state,
    mode: SERVERLESS ? "serverless" : "background",
    ...(SERVERLESS ? { leader: Boolean(kickInFlight) || state.leader } : {}),
  };
}

/** Called by the API after starting/resuming a campaign so sending begins immediately. */
export function wakeWorker() {
  if (wakeResolve) wakeResolve();
  else if (SERVERLESS) kickWorker("wake", { force: true });
}

// ---------------------------------------------------------------------------------------------------------
// Serverless hosts (Vercel) have no long-running process, so the loop above never runs there. Instead the
// worker runs in short passes that are started:
//   1. after API requests (while anyone uses the app) — kickWorker(), throttled;
//   2. right away when a campaign is started/resumed — wakeWorker();
//   3. by GET /api/cron/tick (Vercel Cron or an external scheduler) — so campaigns also send when nobody is online.
// Each pass keeps the function alive after the response with waitUntil(), and uses the same PostgreSQL lease,
// so two passes (or Render + Vercel) never send at the same time.
// ---------------------------------------------------------------------------------------------------------
const SERVERLESS =
  Boolean(process.env.VERCEL) && process.env.SERVERLESS_WORKER !== "off";
const KICK_EVERY_MS = 20_000;
let kickInFlight = null;
let lastKickAt = 0;

export function isServerless() {
  return SERVERLESS;
}

export function kickWorker(reason = "request", { force = false } = {}) {
  if (!SERVERLESS || state.running || kickInFlight) return false;
  if (!force && Date.now() - lastKickAt < KICK_EVERY_MS) return false;
  lastKickAt = Date.now();
  const budgetMs = Math.min(
    250_000,
    Math.max(15_000, Number(process.env.WORKER_KICK_BUDGET_MS) || 40_000),
  );
  kickInFlight = runWorkerOnce({ budgetMs, minGapMs: force ? 0 : 25_000 })
    .then((r) => {
      if (r?.sent) logger.info({ reason, ...r }, "serverless worker pass");
      return r;
    })
    .catch((err) =>
      logger.warn(
        { reason, err: err.message },
        "serverless worker pass failed",
      ),
    )
    .finally(() => {
      kickInFlight = null;
    });
  try {
    waitUntil(kickInFlight); // keep the function running after the response has been sent
  } catch {
    /* not inside a Vercel request: the promise still runs while the process lives */
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wakeResolve = () => {
      clearTimeout(t);
      resolve();
    };
  }).finally(() => {
    wakeResolve = null;
  });
}

async function acquireLease() {
  const now = new Date();
  const until = new Date(now.getTime() + LEASE_MS);
  const existing = await prisma.workerLease.findUnique({
    where: { id: LEASE_ID },
  });
  if (!existing) {
    try {
      await prisma.workerLease.create({
        data: {
          id: LEASE_ID,
          instanceId: config.instanceId,
          leaseUntil: until,
          heartbeatAt: now,
          startedAt: now,
        },
      });
      return { acquired: true, previousHeartbeat: null };
    } catch {
      return { acquired: false };
    }
  }
  const res = await prisma.workerLease.updateMany({
    where: {
      id: LEASE_ID,
      OR: [{ instanceId: config.instanceId }, { leaseUntil: { lt: now } }],
    },
    data: {
      instanceId: config.instanceId,
      leaseUntil: until,
      heartbeatAt: now,
      ...(existing.instanceId !== config.instanceId ? { startedAt: now } : {}),
      info: { sent: state.sentThisProcess, active: state.activeCampaigns },
    },
  });
  return {
    acquired: res.count === 1,
    previousHeartbeat:
      existing.instanceId !== config.instanceId ? existing.heartbeatAt : null,
    wasMine: existing.instanceId === config.instanceId,
  };
}

async function releaseLease() {
  try {
    await prisma.workerLease.updateMany({
      where: { id: LEASE_ID, instanceId: config.instanceId },
      data: { leaseUntil: new Date(0) },
    });
  } catch {
    /* best effort */
  }
}

const due = (key, everyMs) => {
  const now = Date.now();
  if (now - timers[key] >= everyMs) {
    timers[key] = now;
    return true;
  }
  return false;
};

async function safe(name, fn) {
  try {
    return await fn();
  } catch (err) {
    state.lastError = {
      task: name,
      message: err.message,
      at: new Date().toISOString(),
    };
    logger.error({ task: name, err: err.message }, "worker task failed");
    if (isTransientDbError(err)) throw err; // escalate so the loop backs off
    return null;
  }
}

async function loop() {
  while (state.running) {
    let sleepMs = config.workerIdleTickMs;
    try {
      if (due("lease", 20_000) || !state.leader) {
        const lease = await acquireLease();
        if (lease.acquired && !state.leader) {
          state.leader = true;
          logger.info("worker lease acquired; recovering state");
          await safe("recordWake", () => recordWake(lease.previousHeartbeat));
          await safe("recoverStuck", () => recoverStuck({ onStartup: true }));
          Object.keys(timers).forEach((k) => {
            if (k !== "lease") timers[k] = 0;
          });
        } else if (!lease.acquired) {
          if (state.leader) logger.warn("worker lease lost");
          state.leader = false;
        }
      }

      if (state.leader) {
        const settings = await getSettings();
        if (due("scheduler", 30_000)) await safe("scheduler", schedulerTick);
        const r = await safe("send", () => sendTick());
        state.lastSendTickAt = new Date().toISOString();
        if (r) {
          state.activeCampaigns = r.active;
          state.sentThisProcess += r.sent;
        }
        if (due("imap", 30_000))
          await safe("imap", () => imapTick({ maxAccounts: 5 }));
        if (due("maintenance", 120_000)) {
          await safe("recover", () => recoverStuck());
          await safe("reconcile", reconcileUnknown);
          await safe("accountHealth", accountHealthTick);
        }
        if (due("health", settings.healthCheckIntervalSec * 1000))
          await safe("health", healthTick);
        if (due("cleanup", 6 * 3_600_000)) await safe("cleanup", cleanupTick);
        sleepMs =
          state.activeCampaigns > 0
            ? config.workerTickMs
            : config.workerIdleTickMs;
        if (r && r.sent >= config.workerBatchSize) sleepMs = 250; // more ready work
      } else {
        sleepMs = 30_000;
      }
      state.consecutiveErrors = 0;
      state.lastTickAt = new Date().toISOString();
    } catch (err) {
      state.consecutiveErrors += 1;
      state.lastError = {
        task: "loop",
        message: err.message,
        at: new Date().toISOString(),
      };
      sleepMs =
        Math.min(60_000, 1000 * 2 ** Math.min(state.consecutiveErrors, 6)) *
        (0.5 + Math.random() / 2);
      logger.warn(
        { err: err.message, retryInMs: Math.round(sleepMs) },
        "worker loop error (database may be waking up)",
      );
    }
    if (state.running) await sleep(sleepMs);
  }
}

export function startWorker() {
  if (!config.runWorker) {
    logger.info("worker disabled (RUN_WORKER=false)");
    return;
  }
  if (state.running) return;
  state.running = true;
  state.startedAt = new Date().toISOString();
  loopPromise = loop();
  logger.info("worker started");
}

export async function stopWorker(timeoutMs = 25_000) {
  if (!state.running) return;
  state.running = false;
  wakeWorker();
  await Promise.race([
    loopPromise,
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  if (state.leader) await releaseLease();
  state.leader = false;
  closeAllTransports();
  logger.info("worker stopped");
}

/**
 * One bounded worker pass, for serverless hosts (Vercel) where no background loop can run.
 * Uses the same PostgreSQL lease, so it never runs alongside another active worker (e.g. on Render).
 */
export async function runWorkerOnce({ budgetMs = 50_000, minGapMs = 0 } = {}) {
  if (state.running)
    return {
      ok: true,
      skipped: "the background worker is already running in this process",
    };
  const started = Date.now();
  if (minGapMs > 0) {
    // Another instance ran a pass a moment ago: nothing to do yet (keeps database work low).
    const last = await prisma.workerLease.findUnique({
      where: { id: LEASE_ID },
      select: { heartbeatAt: true },
    });
    if (last && Date.now() - new Date(last.heartbeatAt).getTime() < minGapMs)
      return { ok: true, skipped: "ran recently" };
  }
  const lease = await acquireLease();
  if (!lease.acquired)
    return { ok: true, skipped: "another worker holds the lease" };
  const out = { ok: true, sent: 0, active: 0, ms: 0 };
  try {
    await safe("recordWake", () => recordWake(lease.previousHeartbeat));
    await safe("recoverStuck", () =>
      recoverStuck({ onStartup: !lease.wasMine }),
    );
    const settings = await getSettings();
    await safe("scheduler", schedulerTick);
    // Keep sending while there is ready work and time left (per-account pacing still applies).
    while (Date.now() - started < budgetMs - 8_000) {
      const r = await safe("send", () => sendTick());
      if (!r) break;
      out.sent += r.sent;
      out.active = r.active;
      if (r.active === 0) break;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          r.sent >= config.workerBatchSize ? 250 : config.workerTickMs,
        ),
      );
      await acquireLease(); // heartbeat
    }
    if (Date.now() - started < budgetMs - 15_000)
      await safe("imap", () => imapTick({ maxAccounts: 3 }));
    await safe("reconcile", reconcileUnknown);
    await safe("accountHealth", accountHealthTick);
    await safe("health", healthTick);
    if (settings && new Date().getUTCHours() === 3)
      await safe("cleanup", cleanupTick);
  } finally {
    await releaseLease();
    closeAllTransports();
  }
  out.ms = Date.now() - started;
  state.activeCampaigns = out.active;
  state.sentThisProcess += out.sent;
  state.lastTickAt = new Date().toISOString();
  state.lastSendTickAt = state.lastTickAt;
  return out;
}
