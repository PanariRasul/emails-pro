// Google OAuth 2.0 for Gmail / Google Workspace (SMTP + IMAP via XOAUTH2).
// Enabled only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { decryptSecret } from '../lib/crypto.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

export const googleOAuthEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const redirectUri = () => `${config.publicApiUrl}/api/oauth/google/callback`;

export function googleAuthUrl({ userId, provider, displayName, frontendOrigin, kind = 'account' }) {
  const state = jwt.sign({ uid: userId, provider, displayName, fo: frontendOrigin, purpose: 'oauth', kind }, config.jwtSecret, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: 'https://mail.google.com/ openid email profile',
    state,
  });
  return `${GOOGLE_AUTH}?${params}`;
}

export function verifyState(state) {
  const payload = jwt.verify(state, config.jwtSecret);
  if (payload.purpose !== 'oauth') throw new Error('Invalid OAuth state');
  return payload;
}

async function tokenRequest(body) {
  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      ...body,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Google token error: ${json.error || res.status}`);
    e.code = 'EAUTH';
    throw e;
  }
  return json;
}

export async function exchangeCode(code) {
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  const info = await fetch(GOOGLE_USERINFO, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(15000),
  }).then((r) => r.json());
  if (!info.email || info.email_verified === false) throw new Error('Google account email not verified');
  return { email: info.email.toLowerCase(), name: info.name, refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresIn: tokens.expires_in };
}

// Short-lived access tokens cached in memory (disposable; re-derived from the encrypted refresh token).
const accessCache = new Map();

export async function getAccessToken(account) {
  const hit = accessCache.get(account.id);
  if (hit && hit.exp - 60_000 > Date.now()) return hit.token;
  const refresh = decryptSecret(account.oauthRefreshEnc);
  if (!refresh) {
    const e = new Error('OAuth refresh token missing — reconnect this account');
    e.code = 'EAUTH';
    throw e;
  }
  const t = await tokenRequest({ refresh_token: refresh, grant_type: 'refresh_token' });
  accessCache.set(account.id, { token: t.access_token, exp: Date.now() + (t.expires_in ?? 3600) * 1000 });
  if (accessCache.size > 500) accessCache.delete(accessCache.keys().next().value);
  return t.access_token;
}

export function forgetAccessToken(accountId) {
  accessCache.delete(accountId);
}
