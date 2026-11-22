// "Continue with Google / Microsoft" sign-in for EXISTING Emails Pro users (no self-registration).
// OpenID Connect authorization-code flow. The redirect URI is on the frontend origin (/api/* is rewritten to
// the API by Render) so the refresh cookie is set first-party.
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

const PROVIDERS = {
  google: {
    enabled: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'openid email profile',
    extra: { prompt: 'select_account' },
  },
  microsoft: {
    enabled: () => Boolean(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET),
    clientId: () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
    get authorize() { return `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/authorize`; },
    get token() { return `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || 'common'}/oauth2/v2.0/token`; },
    scope: 'openid email profile',
    extra: { prompt: 'select_account' },
  },
};

export const ssoProviders = () => Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, p.enabled()]));
export const isSsoProvider = (name) => Object.hasOwn(PROVIDERS, name) && PROVIDERS[name].enabled();
const redirectUri = (name) => `${config.appUrl}/api/auth/sso/${name}/callback`;

export function ssoAuthUrl(name, { remember }) {
  const p = PROVIDERS[name];
  const state = jwt.sign({ purpose: 'sso', provider: name, remember: Boolean(remember) }, config.jwtSecret, { expiresIn: '10m' });
  const q = new URLSearchParams({
    client_id: p.clientId(), redirect_uri: redirectUri(name), response_type: 'code', scope: p.scope, state, ...p.extra,
  });
  return `${p.authorize}?${q}`;
}

export function verifySsoState(name, state) {
  const s = jwt.verify(state, config.jwtSecret);
  if (s.purpose !== 'sso' || s.provider !== name) throw new Error('Invalid state');
  return s;
}

/** Exchange the code and return the verified email address. */
export async function ssoExchange(name, code) {
  const p = PROVIDERS[name];
  const res = await fetch(p.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: p.clientId(), client_secret: p.clientSecret(), code, grant_type: 'authorization_code', redirect_uri: redirectUri(name) }),
    signal: AbortSignal.timeout(15000),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) throw new Error(`token exchange failed (${tok.error || res.status})`);
  // ID token received directly from the provider's token endpoint over TLS (OIDC Core §3.1.3.7).
  const claims = jwt.decode(tok.id_token) || {};
  if (claims.aud !== p.clientId()) throw new Error('ID token audience mismatch');
  const email = String(claims.email || (name === 'microsoft' ? claims.preferred_username : '') || '').toLowerCase();
  if (!email.includes('@')) throw new Error('No email address returned');
  if (name === 'google' && claims.email_verified === false) throw new Error('Google email not verified');
  return { email, name: claims.name };
}
