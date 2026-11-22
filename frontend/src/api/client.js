// API client.
// - Access token kept in memory only; refresh token is an HttpOnly cookie.
// - Request timeouts.
// - GET requests retry with exponential backoff + jitter while the backend/database wakes up.
// - Non-GET requests are NEVER retried automatically (could duplicate a campaign start or a send).
import { useConnection } from '../store/connection.js';

// Default: same-origin "/api" (Render static-site rewrite to the backend). Override with VITE_API_URL.
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

let accessToken = null;
let refreshPromise = null;
let onAuthLost = () => {};

export const setAccessToken = (t) => { accessToken = t; };
export const getAccessToken = () => accessToken;
export const setOnAuthLost = (fn) => { onAuthLost = fn; };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (i) => Math.min(15_000, 1000 * 2 ** i) * (0.6 + Math.random() * 0.8);

async function rawFetch(path, { method = 'GET', body, timeoutMs = 25_000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      signal: ctrl.signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        'X-Requested-With': 'emails-pro',
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function parse(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

/** Single-flight token refresh shared by all concurrent requests. */
export function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const res = await rawFetch('/api/auth/refresh', { method: 'POST', timeoutMs: 30_000 });
      const data = await parse(res);
      if (typeof data !== 'object' || data === null) throw new ApiError(0, { error: { code: 'API_UNREACHABLE', message: 'The website could not reach the Emails Pro server.' } });
      if (!res.ok) throw new ApiError(res.status, data);
      setAccessToken(data.accessToken);
      return data;
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

// 502/503/504, or any 5xx that is not one of our JSON API errors (proxy/edge error page while the service boots).
const isColdStart = (res) => res && (
  [502, 503, 504].includes(res.status)
  || (res.status >= 500 && !(res.headers.get('content-type') || '').includes('application/json'))
);

export async function api(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  // `idempotent: true` lets safe POSTs (e.g. login) retry during a cold start. Never use it for sends/starts.
  const retryable = (method === 'GET' || opts.idempotent === true) && opts.retry !== false;
  const maxAttempts = retryable ? 7 : 1; // ~1+2+4+8+15+15 s ≈ 45 s of patience for a cold start
  const conn = useConnection.getState();
  let lastErr;

  for (let i = 0; i < maxAttempts; i += 1) {
    let res;
    try {
      res = await rawFetch(path, { ...opts, method });
    } catch (err) {
      lastErr = err;
      if (!retryable) {
        conn.setStatus('offline');
        throw new ApiError(0, { error: { code: 'NETWORK', message: 'Cannot reach Emails Pro. If the server was asleep it may be starting — please check the result before retrying.' } });
      }
      conn.setStatus('waking', i + 1);
      await sleep(backoff(i));
      continue;
    }

    if (isColdStart(res) && retryable) {
      conn.setStatus('waking', i + 1);
      await sleep(backoff(i));
      continue;
    }

    if (res.status === 401 && !opts._retried && !path.startsWith('/api/auth/')) {
      try {
        await refreshSession();
        return api(path, { ...opts, _retried: true });
      } catch {
        onAuthLost();
        throw new ApiError(401, { error: { code: 'UNAUTHORIZED', message: 'Your session has expired. Please sign in again.' } });
      }
    }

    const data = await parse(res);
    // Every Emails Pro API answer is JSON. Anything else (an empty body, an HTML page) means the request
    // never reached our backend — usually the website's /api rewrite points to the wrong address.
    if (typeof data !== 'object' || data === null) {
      conn.setStatus('offline');
      throw new ApiError(0, { error: { code: 'API_UNREACHABLE', message: `The website could not reach the Emails Pro server (it answered ${res.status} without data). Check that the /api rewrite of the website points to your backend address.` } });
    }
    if (res.status < 500) conn.setStatus('online');
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  conn.setStatus('offline');
  throw new ApiError(0, { error: { code: 'NETWORK', message: lastErr?.name === 'AbortError' ? 'The server is taking too long to respond.' : 'Emails Pro is unavailable right now.' } });
}

export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { ...o, method: 'POST', body: body ?? {} });
export const put = (p, body, o) => api(p, { ...o, method: 'PUT', body });
export const patch = (p, body, o) => api(p, { ...o, method: 'PATCH', body });
export const del = (p, o) => api(p, { ...o, method: 'DELETE' });

export function qs(params) {
  const s = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') s.set(k, v); });
  const str = s.toString();
  return str ? `?${str}` : '';
}

/** Authenticated file download (CSV export). */
export async function download(path, filename) {
  const res = await rawFetch(path);
  if (!res.ok) throw new ApiError(res.status, await parse(res));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/** Lightweight probe used by the connection banner and admin health monitor (no auth, no retries). */
export async function probeHealth(timeoutMs = 20_000) {
  const t0 = performance.now();
  try {
    const res = await rawFetch('/api/health', { timeoutMs });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) return { ok: false, ms, status: res.status };
    return { ok: true, ms, data: await res.json() };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: err.name === 'AbortError' ? 'timeout' : 'network' };
  }
}