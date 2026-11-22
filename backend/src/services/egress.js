// Detects whether this host can open outbound SMTP connections (Render Free blocks 25/465/587).
// Result is cached; it is informational and used to explain connection failures clearly.
import net from 'node:net';
import { logger } from '../lib/logger.js';

const PROBE_HOST = process.env.SMTP_EGRESS_PROBE_HOST || 'smtp.gmail.com';
const PORTS = [587, 465, 25];
let cache = null;
let inflight = null;

function canConnect(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: PROBE_HOST, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function smtpEgress({ force = false } = {}) {
  if (cache && !force && Date.now() - cache.checkedAt < 30 * 60_000) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const results = await Promise.all(PORTS.map(async (p) => [p, await canConnect(p)]));
    const open = results.filter(([, ok]) => ok).map(([p]) => p);
    // If nothing at all is reachable we can't distinguish "blocked" from "no network"; report unknown.
    const anyOpen = open.length > 0;
    cache = {
      checkedAt: Date.now(),
      probeHost: PROBE_HOST,
      openPorts: open,
      blockedPorts: anyOpen ? PORTS.filter((p) => !open.includes(p)) : [],
      status: !anyOpen ? 'unknown' : [587, 465].some((p) => !open.includes(p)) ? 'restricted' : 'open',
    };
    if (cache.status === 'restricted') logger.warn({ blocked: cache.blockedPorts }, 'outbound SMTP ports are blocked on this host; use HTTPS transports (Gmail API / SES API) or port 2525 relays');
    return cache;
  })().finally(() => { inflight = null; });
  return inflight;
}
