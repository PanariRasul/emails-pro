// Public endpoints reached from inside emails: open pixel, click redirect, unsubscribe (RFC 8058 one-click),
// plus health/readiness probes. No authentication; tokens are opaque random values.
import { Router } from 'express';
import express from 'express';
import { config } from '../config/index.js';
import { prisma, pingDb } from '../lib/prisma.js';
import { sha256 } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { rateLimit } from '../lib/rateLimit.js';
import { pingRedis, redisConfigured } from '../lib/redis.js';
import { escapeHtml, verifyClick } from '../services/template.js';
import { workerState } from '../worker/index.js';

const router = Router();
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,40}$/;
const BOT_UA = /(bot|crawler|spider|scanner|preview|proofpoint|mimecast|barracuda|symantec|forcepoint|safelinks|urldefense|curl|wget|python-requests|go-http-client|headless)/i;

const ipHash = (req) => sha256(`${req.ip}|${config.trackingSecret}`).slice(0, 16);

function looksAutomated(req, sentAt, windowMs) {
  const ua = req.get('user-agent') || '';
  if (!ua || BOT_UA.test(ua)) return true;
  return Boolean(sentAt && Date.now() - new Date(sentAt).getTime() < windowMs);
}

async function findRecipient(token) {
  if (!TOKEN_RE.test(token)) return null;
  return prisma.campaignRecipient.findUnique({
    where: { token },
    select: { id: true, campaignId: true, email: true, sentAt: true, openedAt: true, openCount: true, clickCount: true, unsubscribedAt: true, campaign: { select: { ownerId: true } } },
  });
}

const trackLimiter = rateLimit({ name: 'track', max: 120, windowSec: 60 });

// ---------- open pixel ----------
router.get('/t/o/:token.gif', trackLimiter, (req, res) => {
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache' });
  res.end(PIXEL);
  // Record after responding so tracking never slows the email client down.
  (async () => {
    const r = await findRecipient(req.params.token);
    if (!r) return;
    const bot = looksAutomated(req, r.sentAt, 5_000);
    const now = new Date();
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { openCount: { increment: 1 }, ...(!r.openedAt && !bot ? { openedAt: now } : {}) },
    });
    if (r.openCount < 20) {
      await prisma.trackingEvent.create({ data: { recipientId: r.id, campaignId: r.campaignId, type: 'OPEN', userAgent: req.get('user-agent')?.slice(0, 300), ipHash: ipHash(req), suspectedBot: bot } });
    }
  })().catch((err) => logger.warn({ err: err.message }, 'open tracking failed'));
});

// ---------- click redirect ----------
router.get('/t/c/:token', trackLimiter, async (req, res) => {
  const url = String(req.query.u || '');
  const sig = String(req.query.s || '');
  let target;
  try { target = new URL(url); } catch { return res.status(400).send('Invalid link'); }
  if (!['http:', 'https:'].includes(target.protocol) || !verifyClick(req.params.token, url, sig)) {
    return res.status(400).send('Invalid or tampered link');
  }
  res.redirect(302, target.toString());
  (async () => {
    const r = await findRecipient(req.params.token);
    if (!r) return;
    const bot = looksAutomated(req, r.sentAt, 10_000);
    const now = new Date();
    await prisma.campaignRecipient.update({
      where: { id: r.id },
      data: { clickCount: { increment: 1 }, ...(!bot ? { clickedAt: now, ...(!r.openedAt ? { openedAt: now } : {}) } : {}) },
    });
    if (r.clickCount < 50) {
      await prisma.trackingEvent.create({ data: { recipientId: r.id, campaignId: r.campaignId, type: 'CLICK', url: url.slice(0, 1000), userAgent: req.get('user-agent')?.slice(0, 300), ipHash: ipHash(req), suspectedBot: bot } });
    }
  })().catch((err) => logger.warn({ err: err.message }, 'click tracking failed'));
});

// ---------- unsubscribe ----------
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#1f2937;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;max-width:420px;text-align:center}
button{background:#111827;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}p{color:#4b5563}</style></head>
<body><div class="card">${body}</div></body></html>`;
}

async function unsubscribe(token, source) {
  const r = await findRecipient(token);
  if (!r) return null;
  if (!r.unsubscribedAt) {
    await prisma.$transaction([
      prisma.campaignRecipient.update({ where: { id: r.id }, data: { unsubscribedAt: new Date() } }),
      prisma.suppression.upsert({
        where: { scopeKey_email: { scopeKey: 'global', email: r.email } },
        update: {},
        create: { scopeKey: 'global', email: r.email, reason: 'UNSUBSCRIBE', source, campaignId: r.campaignId },
      }),
      prisma.trackingEvent.create({ data: { recipientId: r.id, campaignId: r.campaignId, type: 'UNSUBSCRIBE' } }),
      // Stop any not-yet-sent emails to this address immediately.
      prisma.campaignRecipient.updateMany({
        where: { email: r.email, status: { in: ['PENDING', 'ON_HOLD'] } },
        data: { status: 'SUPPRESSED', lastError: 'Unsubscribed' },
      }),
    ]);
  }
  return r;
}

const unsubLimiter = rateLimit({ name: 'unsub', max: 30, windowSec: 60 });

router.get('/u/:token', unsubLimiter, async (req, res, next) => {
  try {
    const r = await findRecipient(req.params.token);
    if (!r) return res.status(404).send(page('Link not found', '<h2>Link not found</h2><p>This unsubscribe link is invalid or has expired.</p>'));
    if (r.unsubscribedAt) return res.send(page('Unsubscribed', '<h2>You are unsubscribed</h2><p>You will not receive further emails from us.</p>'));
    // GET never changes state (link scanners prefetch URLs); the user confirms with a POST.
    return res.send(page('Unsubscribe', `<h2>Unsubscribe</h2><p>Stop receiving emails at <b>${escapeHtml(r.email)}</b>?</p>
      <form method="post"><button type="submit">Unsubscribe</button></form>`));
  } catch (err) { return next(err); }
});

// RFC 8058 one-click: mail clients POST "List-Unsubscribe=One-Click" here.
router.post('/u/:token', unsubLimiter, express.urlencoded({ extended: false, limit: '2kb' }), async (req, res, next) => {
  try {
    const one = req.body?.['List-Unsubscribe'] === 'One-Click';
    const r = await unsubscribe(req.params.token, one ? 'one-click' : 'link');
    if (!r) return res.status(404).send(page('Link not found', '<h2>Link not found</h2>'));
    if (one) return res.status(200).send('Unsubscribed');
    return res.send(page('Unsubscribed', '<h2>You have been unsubscribed</h2><p>You will not receive further emails from us.</p>'));
  } catch (err) { return next(err); }
});

// ---------- health ----------
// /health is cheap and DB-independent so Render's health check never restarts the service just
// because Neon is waking up. /ready reports dependency status.
function health(_req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    app: config.appName,
    version: config.version,
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
  });
}

async function ready(_req, res) {
  res.set('Cache-Control', 'no-store');
  const out = { app: config.appName, version: config.version, timestamp: new Date().toISOString(), checks: {} };
  let ok = true;
  try {
    const ms = await Promise.race([pingDb(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    out.checks.database = { ok: true, latencyMs: ms };
  } catch {
    ok = false;
    out.checks.database = { ok: false, message: 'Database unavailable or waking up' };
  }
  if (redisConfigured()) {
    try { out.checks.redis = { ok: true, latencyMs: await pingRedis() }; } catch { out.checks.redis = { ok: false }; }
  } else {
    out.checks.redis = { ok: true, configured: false };
  }
  const w = workerState();
  out.checks.worker = { ok: !w.enabled || w.running, enabled: w.enabled, leader: w.leader, lastTickAt: w.lastTickAt };
  out.status = ok ? 'ready' : 'degraded';
  res.status(ok ? 200 : 503).json(out);
}

router.get('/health', health);
router.get('/api/health', health);
router.get('/ready', ready);
router.get('/api/ready', ready);

export default router;
