import { Router } from 'express';
import { z } from 'zod';
import { hash, verify } from '@node-rs/argon2';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { ah, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { rateLimit } from '../lib/rateLimit.js';
import { validate } from '../middleware/common.js';
import { requireAuth, signAccessToken, invalidateUser } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';
import { employeeLimits } from '../services/limits.js';
import { OTP_RESEND_SECONDS, maskEmail, resendChallenge, startChallenge, verifyChallenge } from '../services/otp.js';
import { systemMailStatus } from '../services/systemMail.js';
import { isSsoProvider, ssoAuthUrl, ssoExchange, ssoProviders, verifySsoState } from '../services/sso.js';
import { logger } from '../lib/logger.js';

export const ARGON_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // Argon2id (OWASP baseline)
export const hashPassword = (pw) => hash(pw, ARGON_OPTS);

let dummyPromise;
const dummyHash = () => (dummyPromise ??= hashPassword(randomToken(16)));

const COOKIE = 'ep_rt';
const SESSION_TTL_DAYS = 1; // "Remember me" off
const router = Router();

function cookieOpts(persistent = true) {
  return {
    httpOnly: true,
    secure: config.isProd || config.cookieSameSite === 'none',
    sameSite: config.cookieSameSite,
    path: '/api/auth',
    ...(persistent ? { maxAge: config.refreshTokenTtlDays * 86_400_000 } : {}), // otherwise a browser-session cookie
  };
}
const clearCookie = (res) => res.clearCookie(COOKIE, { ...cookieOpts(false) });

/** CSRF defence for cookie-authenticated endpoints: custom header (forces CORS preflight) + Origin allow-list. */
function csrfGuard(req, _res, next) {
  if (req.get('x-requested-with') !== 'emails-pro') return next(forbidden('Missing CSRF header'));
  const origin = req.get('origin');
  if (origin && !config.corsOrigins.includes(origin.replace(/\/$/, '')) && !isSameOrigin(req, origin)) {
    return next(forbidden('Origin not allowed'));
  }
  return next();
}

function isSameOrigin(req, origin) {
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}

async function issueRefresh(res, userId, { familyId = null, persistent = true, userAgent } = {}) {
  const raw = randomToken(32);
  const days = persistent ? config.refreshTokenTtlDays : SESSION_TTL_DAYS;
  const row = await prisma.refreshToken.create({
    data: {
      userId, persistent,
      tokenHash: sha256(raw),
      familyId: familyId || randomToken(12),
      expiresAt: new Date(Date.now() + days * 86_400_000),
      userAgent: userAgent?.slice(0, 200),
    },
  });
  res.cookie(COOKIE, raw, cookieOpts(persistent));
  return row;
}

async function publicUser(user) {
  const settings = await getSettings();
  const limits = user.role === 'EMPLOYEE' ? employeeLimits(user, settings) : null;
  return {
    id: user.id, email: user.email, name: user.name, role: user.role, phone: user.phone ?? null, title: user.title ?? null,
    sendingDisabled: user.sendingDisabled, requireApproval: user.requireApproval,
    limits: limits ? { ...limits, maxWorkingCampaigns: settings.maxWorkingCampaigns } : null,
  };
}

/** Create a session (refresh cookie + access token). */
async function startSession(req, res, user, { persistent, method }) {
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await issueRefresh(res, user.id, { persistent, userAgent: req.get('user-agent') });
  audit({ ...req, user }, 'auth.login', 'User', user.id, { method });
  return { accessToken: signAccessToken(user), user: await publicUser(user) };
}

async function otpRequired(user) {
  const s = await getSettings();
  if (!s.otpLoginEnabled) return false;
  return user.role === 'EMPLOYEE' || s.otpForAdmins;
}

// ---------- public sign-in options (for the login page) ----------
router.get('/options', ah(async (_req, res) => {
  const [s, mail] = await Promise.all([getSettings(), systemMailStatus()]);
  res.json({ sso: ssoProviders(), otpLogin: s.otpLoginEnabled, passwordReset: mail.configured });
}));

// ---------- password login (+ optional email OTP step) ----------
const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
  remember: z.boolean().default(true),
});

router.post('/login',
  rateLimit({ name: 'login-ip', max: 20, windowSec: 900 }),
  rateLimit({ name: 'login-email', max: 8, windowSec: 900, key: (req) => String(req.body?.email || '').toLowerCase() }),
  validate({ body: loginSchema }),
  ah(async (req, res) => {
    const { email, password, remember } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    // Always run a verification to keep timing similar for unknown emails.
    const ok = user
      ? await verify(user.passwordHash, password).catch(() => false)
      : await verify(await dummyHash(), password).catch(() => false);
    if (!user || !ok) throw unauthorized('Invalid email or password');
    if (!user.isActive) throw forbidden('Your account has been deactivated. Contact your administrator.');

    if (await otpRequired(user)) {
      const ch = await startChallenge(user, 'LOGIN', { remember, ip: req.ip });
      audit({ ...req, user }, 'auth.otp_sent', 'User', user.id);
      return res.json({ otpRequired: true, challengeId: ch.id, email: maskEmail(user.email), resendIn: OTP_RESEND_SECONDS });
    }
    return res.json(await startSession(req, res, user, { persistent: remember, method: 'password' }));
  }));

const challengeSchema = z.object({ challengeId: z.string().min(10).max(40) });

router.post('/login/verify',
  rateLimit({ name: 'otp-verify', max: 20, windowSec: 900 }),
  validate({ body: challengeSchema.extend({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }) }),
  ah(async (req, res) => {
    const ch = await verifyChallenge(req.body.challengeId, req.body.code, 'LOGIN');
    if (!ch.user.isActive) throw forbidden('Your account has been deactivated.');
    res.json(await startSession(req, res, ch.user, { persistent: ch.remember, method: 'password+otp' }));
  }));

router.post('/login/resend',
  rateLimit({ name: 'otp-resend', max: 10, windowSec: 900 }),
  validate({ body: challengeSchema }),
  ah(async (req, res) => {
    await resendChallenge(req.body.challengeId, 'LOGIN');
    res.json({ ok: true, resendIn: OTP_RESEND_SECONDS });
  }));

// ---------- forgot / reset password (email code) ----------
router.post('/password/forgot',
  rateLimit({ name: 'forgot-ip', max: 10, windowSec: 900 }),
  rateLimit({ name: 'forgot-email', max: 4, windowSec: 900, key: (req) => String(req.body?.email || '').toLowerCase() }),
  validate({ body: z.object({ email: z.string().trim().toLowerCase().email().max(200) }) }),
  ah(async (req, res) => {
    const mail = await systemMailStatus();
    if (!mail.configured) throw badRequest('Password reset by email is not available. Ask your administrator to reset your password.');
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (user?.isActive) {
      try {
        await startChallenge(user, 'PASSWORD_RESET', { ip: req.ip });
        audit({ ...req, user }, 'auth.password_reset_requested', 'User', user.id);
      } catch (err) {
        logger.warn({ err: err.message }, 'password reset email failed');
        throw err;
      }
    }
    // Same response whether or not the account exists (no account enumeration).
    res.json({ ok: true, message: 'If an account exists for that email, a reset code has been sent.' });
  }));

router.post('/password/reset',
  rateLimit({ name: 'reset-ip', max: 20, windowSec: 900 }),
  validate({
    body: z.object({
      email: z.string().trim().toLowerCase().email().max(200),
      code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
      newPassword: z.string().min(10, 'Use at least 10 characters').max(200),
    }),
  }),
  ah(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    const ch = user && await prisma.authChallenge.findFirst({
      where: { userId: user.id, purpose: 'PASSWORD_RESET', consumedAt: null }, orderBy: { createdAt: 'desc' },
    });
    if (!ch) throw badRequest('Incorrect or expired code');
    await verifyChallenge(ch.id, req.body.code, 'PASSWORD_RESET');
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(req.body.newPassword), tokenVersion: { increment: 1 } } }),
      prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    invalidateUser(user.id);
    audit({ ...req, user }, 'auth.password_reset', 'User', user.id);
    res.json({ ok: true });
  }));

// ---------- Continue with Google / Microsoft (existing users only) ----------
router.get('/sso/:provider/start', ah(async (req, res) => {
  const { provider } = req.params;
  if (!isSsoProvider(provider)) return res.redirect(`${config.appUrl}/login?sso=error&message=${encodeURIComponent('This sign-in option is not configured')}`);
  return res.redirect(ssoAuthUrl(provider, { remember: req.query.remember !== 'false' }));
}));

router.get('/sso/:provider/callback', ah(async (req, res) => {
  const { provider } = req.params;
  const fail = (m) => res.redirect(`${config.appUrl}/login?sso=error&message=${encodeURIComponent(m)}`);
  if (!isSsoProvider(provider)) return fail('This sign-in option is not configured');
  if (req.query.error) return fail('Sign-in was cancelled');
  let state;
  try { state = verifySsoState(provider, String(req.query.state || '')); } catch { return fail('Sign-in request expired. Please try again.'); }
  try {
    const { email } = await ssoExchange(provider, String(req.query.code || ''));
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return fail(`No Emails Pro account uses ${email}. Ask your administrator to invite you.`);
    if (!user.isActive) return fail('Your account has been deactivated.');
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await issueRefresh(res, user.id, { persistent: state.remember, userAgent: req.get('user-agent') });
    audit({ ...req, user }, 'auth.login', 'User', user.id, { method: `sso:${provider}` });
    return res.redirect(`${config.appUrl}/login?sso=success`);
  } catch (err) {
    logger.warn({ provider, err: err.message }, 'sso sign-in failed');
    return fail('Sign-in failed. Please try again.');
  }
}));

// ---------- session ----------
// Per-session limit (offices share one NAT IP, so a tight per-IP limit would lock everyone out) + a generous per-IP cap.
const sessionKey = (req) => sha256(req.cookies?.[COOKIE] || req.ip).slice(0, 24);
router.post('/refresh', rateLimit({ name: 'refresh-session', max: 40, windowSec: 300, key: sessionKey }), rateLimit({ name: 'refresh-ip', max: 1500, windowSec: 300 }), csrfGuard, ah(async (req, res) => {
  const raw = req.cookies?.[COOKIE];
  if (!raw) throw unauthorized('No session');
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
  if (!row) { clearCookie(res); throw unauthorized('Session not found'); }
  if (!row.user.isActive) throw unauthorized('Account deactivated');

  if (row.revokedAt) {
    // Benign race (two tabs refreshing at once): allow a short grace window after rotation.
    if (row.replacedBy && Date.now() - row.revokedAt.getTime() < 15_000) {
      return res.json({ accessToken: signAccessToken(row.user), user: await publicUser(row.user) });
    }
    // Reuse of an old token => likely theft. Revoke the whole family.
    await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    audit({ ...req, user: row.user }, 'auth.refresh_reuse_detected', 'User', row.userId);
    clearCookie(res);
    throw unauthorized('Session revoked');
  }
  if (row.expiresAt < new Date()) throw unauthorized('Session expired');

  const next = await issueRefresh(res, row.userId, { familyId: row.familyId, persistent: row.persistent, userAgent: req.get('user-agent') });
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date(), replacedBy: next.id } });
  res.json({ accessToken: signAccessToken(row.user), user: await publicUser(row.user) });
}));

router.post('/logout', csrfGuard, ah(async (req, res) => {
  const raw = req.cookies?.[COOKIE];
  if (raw) {
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
    if (row) await prisma.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  clearCookie(res);
  res.json({ ok: true });
}));

router.get('/me', requireAuth, ah(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  res.json({ user: await publicUser(user) });
}));

router.patch('/me', requireAuth, validate({
  body: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(40).optional().nullable(),
    title: z.string().trim().max(80).optional().nullable(),
  }),
}), ah(async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.user.id }, data: req.body });
  invalidateUser(user.id);
  audit(req, 'auth.profile_updated', 'User', user.id);
  res.json({ user: await publicUser(user) });
}));

router.get('/sessions', requireAuth, ah(async (req, res) => {
  const rows = await prisma.refreshToken.findMany({
    where: { userId: req.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, userAgent: true, createdAt: true, persistent: true },
    orderBy: { createdAt: 'desc' }, take: 20,
  });
  res.json({ sessions: rows });
}));

router.post('/sessions/revoke-all', requireAuth, csrfGuard, ah(async (req, res) => {
  await prisma.$transaction([
    prisma.refreshToken.updateMany({ where: { userId: req.user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.user.update({ where: { id: req.user.id }, data: { tokenVersion: { increment: 1 } } }),
  ]);
  invalidateUser(req.user.id);
  audit(req, 'auth.sessions_revoked', 'User', req.user.id);
  clearCookie(res);
  res.json({ ok: true });
}));

const pwSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(10, 'Use at least 10 characters').max(200),
});

router.post('/change-password', requireAuth, validate({ body: pwSchema }), ah(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!(await verify(user.passwordHash, req.body.currentPassword).catch(() => false))) throw badRequest('Current password is incorrect');
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(req.body.newPassword), tokenVersion: { increment: 1 } } }),
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  invalidateUser(user.id);
  audit(req, 'auth.password_changed', 'User', user.id);
  clearCookie(res);
  res.json({ ok: true });
}));

export default router;
