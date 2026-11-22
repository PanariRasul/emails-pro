// Fixed-window request rate limiter. Uses Redis when configured (shared across instances),
// otherwise a bounded in-memory map (fine for a single Render Free instance).
import { redis } from './redis.js';
import { HttpError } from './errors.js';

const memory = new Map();
const MAX_KEYS = 10_000;

async function hit(key, windowSec) {
  const r = redis();
  if (r) {
    try {
      const k = `rl:${key}`;
      const n = await r.incr(k);
      if (n === 1) await r.expire(k, windowSec);
      return n;
    } catch { /* fall back to memory */ }
  }
  const now = Date.now();
  let e = memory.get(key);
  if (!e || e.reset < now) {
    e = { n: 0, reset: now + windowSec * 1000 };
    if (memory.size >= MAX_KEYS) memory.delete(memory.keys().next().value);
    memory.set(key, e);
  }
  e.n += 1;
  return e.n;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memory) if (v.reset < now) memory.delete(k);
}, 60_000).unref();

export function rateLimit({ name, max, windowSec, key = (req) => req.ip }) {
  return async (req, _res, next) => {
    try {
      const n = await hit(`${name}:${key(req)}`, windowSec);
      if (n > max) return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.'));
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
