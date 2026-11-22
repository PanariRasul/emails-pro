import { monitorEventLoopDelay } from 'node:perf_hooks';
import { prisma, pingDb } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { pingRedis, redisConfigured } from '../lib/redis.js';
import { notify } from '../services/audit.js';

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

export function processStats() {
  const m = process.memoryUsage();
  const mb = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
  return {
    uptimeSec: Math.round(process.uptime()),
    memoryMb: { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external) },
    eventLoopDelayMs: { mean: Math.round(loopDelay.mean / 1e6), p99: Math.round(loopDelay.percentile(99) / 1e6), max: Math.round(loopDelay.max / 1e6) },
  };
}

const lastState = new Map();

async function record(component, ok, latencyMs, detail) {
  await prisma.healthCheck.create({ data: { component, ok, latencyMs: latencyMs ?? null, detail: detail ? String(detail).slice(0, 300) : null } });
  const prev = lastState.get(component);
  lastState.set(component, ok);
  if (prev === true && !ok) {
    await notify({ forAdmins: true, type: 'health.down', title: `${component} check failing`, body: detail });
  } else if (prev === false && ok) {
    await notify({ forAdmins: true, type: 'health.recovered', title: `${component} recovered` });
  }
}

/** Periodic self-check. Runs inside the service, so it can only observe itself while awake — it is not a keep-alive. */
export async function healthTick() {
  try {
    const dbMs = await pingDb();
    await record('DATABASE', true, dbMs);
  } catch (err) {
    logger.warn({ err: err.message }, 'health: database check failed');
    lastState.set('DATABASE', false);
    return; // can't record without the DB
  }
  if (redisConfigured()) {
    try { await record('REDIS', true, await pingRedis()); } catch (err) { await record('REDIS', false, null, err.message); }
  }
  const s = processStats();
  const memOk = s.memoryMb.rss < 450;
  await record('API', memOk, s.eventLoopDelayMs.p99, `rss=${s.memoryMb.rss}MB heap=${s.memoryMb.heapUsed}MB loopP99=${s.eventLoopDelayMs.p99}ms`);
  loopDelay.reset();
}

/** Called when the worker (re)acquires its lease; records how long the service was asleep/unavailable. */
export async function recordWake(previousHeartbeat) {
  if (!previousHeartbeat) {
    await record('WORKER', true, null, 'Worker started');
    return;
  }
  const gapMin = Math.round((Date.now() - new Date(previousHeartbeat).getTime()) / 60_000);
  if (gapMin >= 3) {
    await record('WORKER', true, null, `Resumed after ~${gapMin} min without a heartbeat (service sleep or restart). Scheduled work is now catching up.`);
    if (gapMin >= 30) {
      await notify({ forAdmins: true, type: 'worker.resumed', title: `Worker resumed after ${gapMin} minutes`, body: 'Render Free services sleep when idle; scheduled sends and IMAP sync were delayed during this time.' });
    }
  } else {
    await record('WORKER', true, null, 'Worker restarted');
  }
}
