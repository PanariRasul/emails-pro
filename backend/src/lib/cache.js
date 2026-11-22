// Small bounded in-memory TTL cache (LRU eviction). Disposable by design:
// it is rebuilt from PostgreSQL after restarts and must never hold authoritative
// sending state, quotas, locks or rate limits.

export class TtlCache {
  constructor({ max = 500, ttlMs = 30_000, name = 'cache' } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.name = name;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.inflight = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) { this.misses += 1; return undefined; }
    if (entry.expires < Date.now()) { this.map.delete(key); this.misses += 1; return undefined; }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  /** Get or compute; concurrent callers for the same key share one in-flight promise. */
  async wrap(key, fn, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await fn();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  del(key) { this.map.delete(key); }

  delPrefix(prefix) {
    for (const k of this.map.keys()) if (String(k).startsWith(prefix)) this.map.delete(k);
  }

  clear() { this.map.clear(); }

  stats() {
    return { name: this.name, size: this.map.size, max: this.max, hits: this.hits, misses: this.misses };
  }
}

export const caches = {
  settings: new TtlCache({ name: 'settings', max: 5, ttlMs: 60_000 }),
  users: new TtlCache({ name: 'users', max: 300, ttlMs: 60_000 }),
  dashboard: new TtlCache({ name: 'dashboard', max: 300, ttlMs: 30_000 }),
  stats: new TtlCache({ name: 'stats', max: 500, ttlMs: 30_000 }),
  accounts: new TtlCache({ name: 'accounts', max: 300, ttlMs: 60_000 }),
};

export function cacheStats() {
  return Object.values(caches).map((c) => c.stats());
}

/** Invalidate everything derived from one employee's data. */
export function invalidateOwner(ownerId) {
  caches.dashboard.delPrefix(`emp:${ownerId}`);
  caches.dashboard.delPrefix('admin:');
  caches.stats.delPrefix(`emp:${ownerId}`);
  caches.accounts.delPrefix(`emp:${ownerId}`);
}
