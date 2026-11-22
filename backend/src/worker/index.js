// In-process background worker for Render Free (no separate paid worker service).
// Safety properties:
//  - Lease row in PostgreSQL => only one active scheduler/sender even during deploy overlap.
//  - All state lives in PostgreSQL; on wake/restart the worker recovers and continues.
//  - Adaptive sleep: short ticks only while campaigns are sending; long idle ticks otherwise.
import { config } from '../config/index.js';
import { prisma, isTransientDbError } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { getSettings } from '../services/settings.js';
import { closeAllTransports } from '../services/smtp.js';
import { sendTick } from './sender.js';
import { accountHealthTick, cleanupTick, imapTick, reconcileUnknown, recoverStuck, schedulerTick } from './maintenance.js';
import { healthTick, recordWake } from './health.js';

const LEASE_ID = 'primary';
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
const timers = { scheduler: 0, imap: 0, maintenance: 0, health: 0, cleanup: 0, lease: 0 };

let wakeResolve = null;
let loopPromise = null;

export function workerState() {
  return { ...state };
}

/** Called by the API after starting/resuming a campaign so sending begins immediately. */
export function wakeWorker() {
  if (wakeResolve) wakeResolve();
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wakeResolve = () => { clearTimeout(t); resolve(); };
  }).finally(() => { wakeResolve = null; });
}

async function acquireLease() {
  const now = new Date();
  const until = new Date(now.getTime() + LEASE_MS);
  const existing = await prisma.workerLease.findUnique({ where: { id: LEASE_ID } });
  if (!existing) {
    try {
      await prisma.workerLease.create({ data: { id: LEASE_ID, instanceId: config.instanceId, leaseUntil: until, heartbeatAt: now, startedAt: now } });
      return { acquired: true, previousHeartbeat: null };
    } catch { return { acquired: false }; }
  }
  const res = await prisma.workerLease.updateMany({
    where: { id: LEASE_ID, OR: [{ instanceId: config.instanceId }, { leaseUntil: { lt: now } }] },
    data: {
      instanceId: config.instanceId, leaseUntil: until, heartbeatAt: now,
      ...(existing.instanceId !== config.instanceId ? { startedAt: now } : {}),
      info: { sent: state.sentThisProcess, active: state.activeCampaigns },
    },
  });
  return { acquired: res.count === 1, previousHeartbeat: existing.instanceId !== config.instanceId ? existing.heartbeatAt : null, wasMine: existing.instanceId === config.instanceId };
}

async function releaseLease() {
  try {
    await prisma.workerLease.updateMany({ where: { id: LEASE_ID, instanceId: config.instanceId }, data: { leaseUntil: new Date(0) } });
  } catch { /* best effort */ }
}

const due = (key, everyMs) => {
  const now = Date.now();
  if (now - timers[key] >= everyMs) { timers[key] = now; return true; }
  return false;
};

async function safe(name, fn) {
  try {
    return await fn();
  } catch (err) {
    state.lastError = { task: name, message: err.message, at: new Date().toISOString() };
    logger.error({ task: name, err: err.message }, 'worker task failed');
    if (isTransientDbError(err)) throw err; // escalate so the loop backs off
    return null;
  }
}

async function loop() {
  while (state.running) {
    let sleepMs = config.workerIdleTickMs;
    try {
      if (due('lease', 20_000) || !state.leader) {
        const lease = await acquireLease();
        if (lease.acquired && !state.leader) {
          state.leader = true;
          logger.info('worker lease acquired; recovering state');
          await safe('recordWake', () => recordWake(lease.previousHeartbeat));
          await safe('recoverStuck', () => recoverStuck({ onStartup: true }));
          Object.keys(timers).forEach((k) => { if (k !== 'lease') timers[k] = 0; });
        } else if (!lease.acquired) {
          if (state.leader) logger.warn('worker lease lost');
          state.leader = false;
        }
      }

      if (state.leader) {
        const settings = await getSettings();
        if (due('scheduler', 30_000)) await safe('scheduler', schedulerTick);
        const r = await safe('send', () => sendTick());
        state.lastSendTickAt = new Date().toISOString();
        if (r) { state.activeCampaigns = r.active; state.sentThisProcess += r.sent; }
        if (due('imap', 30_000)) await safe('imap', () => imapTick({ maxAccounts: 5 }));
        if (due('maintenance', 120_000)) {
          await safe('recover', () => recoverStuck());
          await safe('reconcile', reconcileUnknown);
          await safe('accountHealth', accountHealthTick);
        }
        if (due('health', settings.healthCheckIntervalSec * 1000)) await safe('health', healthTick);
        if (due('cleanup', 6 * 3_600_000)) await safe('cleanup', cleanupTick);
        sleepMs = state.activeCampaigns > 0 ? config.workerTickMs : config.workerIdleTickMs;
        if (r && r.sent >= config.workerBatchSize) sleepMs = 250; // more ready work
      } else {
        sleepMs = 30_000;
      }
      state.consecutiveErrors = 0;
      state.lastTickAt = new Date().toISOString();
    } catch (err) {
      state.consecutiveErrors += 1;
      state.lastError = { task: 'loop', message: err.message, at: new Date().toISOString() };
      sleepMs = Math.min(60_000, 1000 * 2 ** Math.min(state.consecutiveErrors, 6)) * (0.5 + Math.random() / 2);
      logger.warn({ err: err.message, retryInMs: Math.round(sleepMs) }, 'worker loop error (database may be waking up)');
    }
    if (state.running) await sleep(sleepMs);
  }
}

export function startWorker() {
  if (!config.runWorker) {
    logger.info('worker disabled (RUN_WORKER=false)');
    return;
  }
  if (state.running) return;
  state.running = true;
  state.startedAt = new Date().toISOString();
  loopPromise = loop();
  logger.info('worker started');
}

export async function stopWorker(timeoutMs = 25_000) {
  if (!state.running) return;
  state.running = false;
  wakeWorker();
  await Promise.race([loopPromise, new Promise((r) => setTimeout(r, timeoutMs))]);
  if (state.leader) await releaseLease();
  state.leader = false;
  closeAllTransports();
  logger.info('worker stopped');
}