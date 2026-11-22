import nodemailer from 'nodemailer';
import dns from 'node:dns/promises';
import { config } from '../config/index.js';
import { decryptSecret } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';
import { getAccessToken } from './oauth.js';
import './smtpPhase.js'; // must load before any SMTP connection is created

/** Provider presets (suggestions — employees can override host/port for regional servers). */
export const PROVIDER_PRESETS = {
  GMAIL: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true, imapHost: 'imap.gmail.com', imapPort: 993, note: 'Recommended: Google sign-in (OAuth) — sends via the Gmail API over HTTPS, which works on Render Free. App-password SMTP needs ports 465/587 (paid backend instance).' },
  GOOGLE_WORKSPACE: { smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpSecure: true, imapHost: 'imap.gmail.com', imapPort: 993, note: 'Recommended: Google sign-in (OAuth) — sends via the Gmail API over HTTPS. App passwords only if your Workspace admin allows them, and SMTP needs a paid backend instance on Render.' },
  ZOHO: { smtpHost: 'smtp.zoho.com', smtpPort: 465, smtpSecure: true, imapHost: 'imap.zoho.com', imapPort: 993, note: 'Regional data centres use smtp.zoho.in / smtp.zoho.eu etc. IMAP must be enabled in Zoho settings. SMTP (465/587) is blocked on Render Free — needs a paid backend instance.' },
  YAHOO: { smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, smtpSecure: true, imapHost: 'imap.mail.yahoo.com', imapPort: 993, note: 'Generate an app password in Yahoo account security settings. SMTP (465/587) is blocked on Render Free — needs a paid backend instance.' },
  REDIFFMAIL: { smtpHost: 'smtp.rediffmailpro.com', smtpPort: 465, smtpSecure: true, imapHost: 'imap.rediffmailpro.com', imapPort: 993, note: 'Server names differ between Rediffmail plans — confirm them with your plan before connecting. SMTP (465/587) is blocked on Render Free — needs a paid backend instance.' },
  AMAZON_SES: { smtpHost: 'email-smtp.us-east-1.amazonaws.com', smtpPort: 587, smtpSecure: false, imapHost: null, imapPort: null, note: 'Choose "SES API" (HTTPS, works on Render Free) with IAM access keys, or SES SMTP credentials on a paid instance. SES is send-only: add a separate IMAP mailbox to receive replies.' },
  CUSTOM: { smtpHost: '', smtpPort: 587, smtpSecure: false, imapHost: '', imapPort: 993, note: 'Port 465 = implicit TLS, 587 = STARTTLS. On Render Free use a relay that accepts port 2525 (STARTTLS).' },
};

async function smtpAuth(account) {
  if (account.authType === 'OAUTH2') {
    return { type: 'OAuth2', user: account.smtpUser, accessToken: await getAccessToken(account) };
  }
  return { user: account.smtpUser, pass: decryptSecret(account.smtpPassEnc) };
}

function transportOptions(account, auth) {
  const insecure = config.smtpDevInsecure;
  return {
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    requireTLS: !account.smtpSecure && !insecure, // never send credentials over plaintext in production
    ignoreTLS: insecure && !account.smtpSecure,
    auth,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: config.smtpTimeoutMs,
    tls: { minVersion: 'TLSv1.2', servername: account.smtpHost },
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

// One reusable transport per account, closed when idle. Bounded so memory stays flat.
const transports = new Map();
const MAX_TRANSPORTS = 25;
const IDLE_MS = 5 * 60_000;

export async function getTransport(account) {
  const key = account.id;
  const stamp = new Date(account.updatedAt).getTime();
  const cached = transports.get(key);
  const oauthFresh = account.authType !== 'OAUTH2' || (cached && cached.createdAt > Date.now() - 45 * 60_000);
  if (cached && cached.stamp === stamp && oauthFresh) {
    cached.lastUsed = Date.now();
    return cached.transport;
  }
  if (cached) closeTransport(key);
  const auth = await smtpAuth(account);
  const transport = nodemailer.createTransport({ ...transportOptions(account, auth), pool: true, maxConnections: 1, maxMessages: 50 });
  transports.set(key, { transport, stamp, lastUsed: Date.now(), createdAt: Date.now() });
  while (transports.size > MAX_TRANSPORTS) {
    let oldest = null;
    for (const [k, v] of transports) if (!oldest || v.lastUsed < oldest[1].lastUsed) oldest = [k, v];
    closeTransport(oldest[0]);
  }
  return transport;
}

export function closeTransport(accountId) {
  const t = transports.get(accountId);
  if (t) {
    try { t.transport.close(); } catch { /* ignore */ }
    transports.delete(accountId);
  }
}

export function closeAllTransports() {
  for (const k of [...transports.keys()]) closeTransport(k);
}

export function transportCount() { return transports.size; }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of transports) if (now - v.lastUsed > IDLE_MS) closeTransport(k);
}, 60_000).unref();

/** Verify SMTP credentials without sending anything. */
export async function testSmtp(account) {
  const auth = await smtpAuth(account);
  const t = nodemailer.createTransport(transportOptions(account, auth));
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeSmtpError(err) };
  } finally {
    t.close();
  }
}

export function describeSmtpError(err) {
  const c = classifySmtpError(err);
  if (c.kind === 'AUTH') return 'Authentication failed — check the username and (app) password.';
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION') return `Could not connect to the SMTP server (${err.code}). Check host, port and TLS mode.`;
  return String(err.response || err.message || 'SMTP error').slice(0, 300);
}

const NETWORK = new Set(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'EDNS', 'ETLS', 'ENOTFOUND']);

/**
 * Classify a send failure.
 *  TRANSIENT          retry with backoff
 *  THROTTLED          provider asked us to slow down — delay account + retry
 *  AUTH               pause the account, notify
 *  INVALID_RECIPIENT  suppress address, never retry
 *  PERMANENT          mark failed, never auto-retry
 *  UNCERTAIN          message may have been accepted — mark UNKNOWN, reconcile, never blind-retry
 */
export function classifySmtpError(err) {
  const code = err?.responseCode ? Number(err.responseCode) : null;
  const text = `${err?.response || ''} ${err?.message || ''}`;
  const command = err?.command ? String(err.command).toUpperCase() : null;

  if (err?.code === 'EAUTH' || code === 535 || code === 534 || code === 530) return { kind: 'AUTH', code };
  if (code && code >= 400 && code < 500) {
    if (/rate|limit|too many|throttl|try again later|exceeded|quota/i.test(text)) return { kind: 'THROTTLED', code };
    return { kind: 'TRANSIENT', code };
  }
  if (code && code >= 500) {
    if (/5\.1\.[0-3]|user unknown|no such user|does not exist|unknown recipient|invalid recipient|recipient rejected|mailbox unavailable|address rejected|not found/i.test(text)) {
      return { kind: 'INVALID_RECIPIENT', code };
    }
    if (/daily (user )?sending (quota|limit)|sending limit exceeded|5\.4\.5/i.test(text)) return { kind: 'THROTTLED', code };
    return { kind: 'PERMANENT', code };
  }
  if (err?.code === 'EENVELOPE') return { kind: 'INVALID_RECIPIENT', code };
  if (NETWORK.has(err?.code) || /timeout|socket|closed|reset/i.test(text)) {
    // Only retry when we KNOW the DATA command was never issued (see smtpPhase.js).
    // `err.command` is not trustworthy here: nodemailer reports socket errors as "CONN" in every phase.
    if (err?.dataPhase === false) return { kind: 'TRANSIENT', code, command };
    return { kind: 'UNCERTAIN', code, command };
  }
  if (err?.code === 'EMESSAGE') return { kind: 'PERMANENT', code };
  return { kind: 'UNCERTAIN', code };
}

/** Lightweight SPF / DMARC presence checks for the sender domain (DKIM needs a selector, so it is optional). */
export async function checkDns(email, dkimSelector) {
  const domain = String(email).split('@')[1];
  const out = { domain, spf: false, dmarc: false, dkim: null };
  if (!domain) return out;
  const txt = async (name) => {
    try { return (await dns.resolveTxt(name)).map((r) => r.join('')); } catch { return []; }
  };
  const [spf, dmarc] = await Promise.all([txt(domain), txt(`_dmarc.${domain}`)]);
  out.spf = spf.some((r) => r.toLowerCase().startsWith('v=spf1'));
  out.dmarc = dmarc.some((r) => r.toLowerCase().startsWith('v=dmarc1'));
  if (dkimSelector) {
    const dk = await txt(`${dkimSelector}._domainkey.${domain}`);
    out.dkim = dk.some((r) => /v=dkim1|p=/i.test(r));
  }
  return out;
}

export async function sendMail(account, message) {
  const transport = await getTransport(account);
  const info = await transport.sendMail(message);
  logger.debug({ accountId: account.id, messageId: message.messageId }, 'smtp accepted');
  return info;
}
