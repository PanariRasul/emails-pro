// Optional Redis. Emails Pro works fully without it; PostgreSQL is always the source of truth.
// When REDIS_URL is set, Redis is used only for shared rate-limit counters and short-lived cache.
import { config } from '../config/index.js';
import { logger } from './logger.js';

let client = null;
let ready = false;

export async function initRedis() {
  if (!config.redisUrl) return null;
  try {
    const { default: Redis } = await import('ioredis');
    client = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5000,
      retryStrategy: (times) => Math.min(30_000, 500 * 2 ** Math.min(times, 6)),
    });
    client.on('ready', () => { ready = true; logger.info('redis connected'); });
    client.on('end', () => { ready = false; });
    client.on('error', (err) => { ready = false; logger.warn({ err: err.message }, 'redis error'); });
    await client.connect().catch((err) => logger.warn({ err: err.message }, 'redis initial connect failed; continuing without it'));
    return client;
  } catch (err) {
    logger.warn({ err: err.message }, 'ioredis not available; continuing without Redis');
    client = null;
    return null;
  }
}

export function redis() {
  return ready ? client : null;
}

export function redisConfigured() {
  return Boolean(config.redisUrl);
}

export async function pingRedis() {
  if (!client) return null;
  const t0 = Date.now();
  await client.ping();
  return Date.now() - t0;
}

export async function closeRedis() {
  if (client) {
    try { await client.quit(); } catch { /* ignore */ }
  }
}
