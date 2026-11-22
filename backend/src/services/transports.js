// Delivery transports.
//
// Render Free web services cannot open outbound connections on SMTP ports 25/465/587. To make sending work on
// the free plan, Emails Pro supports HTTPS (port 443) delivery APIs in addition to SMTP:
//   GMAIL_API  — Gmail / Google Workspace accounts connected with Google sign-in (OAuth 2.0)
//   SES_API    — Amazon SES v2 API (SigV4-signed HTTPS), using IAM access keys
//   SMTP       — any SMTP server (works on paid Render instances, locally, or relays on port 2525)
// Every transport reports failures in the same shape as SMTP errors so classifySmtpError() and the
// duplicate-send protection (`dataPhase`) work identically.
import crypto from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import { decryptSecret } from '../lib/crypto.js';
import { getAccessToken, forgetAccessToken } from './oauth.js';
import { closeTransport, sendMail as smtpSend, testSmtp, describeSmtpError } from './smtp.js';
import { smtpEgress } from './egress.js';

export function transportKind(account) {
  if (account.authType === 'OAUTH2') return 'GMAIL_API';
  if (account.authType === 'SES_API') return 'SES_API';
  return 'SMTP';
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

/** Normalise fetch failures: connect-phase errors are safe to retry; anything later is "uncertain". */
function networkError(err) {
  const code = err?.cause?.code || err?.code;
  const e = new Error(`Network error: ${code || err?.name || err?.message}`);
  e.code = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'ETIMEDOUT' : 'ECONNECTION';
  e.dataPhase = CONNECT_CODES.has(code) ? false : true;
  return e;
}

/** Map an HTTP API error to SMTP-like semantics. */
function httpError(status, text, { invalidRecipient = /invalid (to|recipient)|address.*invalid|not a valid/i } = {}) {
  const e = new Error(`HTTP ${status}: ${String(text).slice(0, 300)}`);
  e.response = e.message;
  e.dataPhase = false;
  if (status === 401 || status === 403) { e.code = 'EAUTH'; e.responseCode = 535; }
  else if (status === 429 || /throttl|rate.?limit|too many|quota|LimitExceeded/i.test(text)) { e.responseCode = 451; e.response = `451 rate limited: ${text}`; }
  else if (status >= 500) { e.responseCode = 421; }
  else if (invalidRecipient.test(text)) { e.responseCode = 550; e.response = `550 5.1.1 invalid recipient: ${text}`; }
  else { e.responseCode = 554; }
  return e;
}

async function httpsFetch(url, init, timeoutMs = 30_000) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw networkError(err);
  }
}

export async function composeRaw(message) {
  const mail = new MailComposer({ ...message, disableFileAccess: true, disableUrlAccess: true }).compile();
  mail.keepBcc = false;
  return mail.build();
}

// ---------------- Gmail API ----------------
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function gmailSend(account, message) {
  const raw = (await composeRaw(message)).toString('base64url');
  const token = await getAccessToken(account);
  const res = await httpsFetch(`${GMAIL}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) forgetAccessToken(account.id);
    throw httpError(res.status, text);
  }
  const sent = JSON.parse(text);
  // Read back the Message-ID Gmail actually used (needed for reply matching + threading).
  let messageId = message.messageId;
  try {
    const meta = await httpsFetch(`${GMAIL}/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`, { headers: { Authorization: `Bearer ${token}` } }, 15_000);
    if (meta.ok) {
      const h = (await meta.json()).payload?.headers?.find((x) => x.name.toLowerCase() === 'message-id');
      if (h?.value) messageId = h.value.trim();
    }
  } catch { /* keep our own Message-ID */ }
  return { messageId, providerMessageId: sent.id, response: `Gmail API accepted id=${sent.id}` };
}

async function gmailTest(account) {
  try {
    const token = await getAccessToken(account);
    const res = await httpsFetch(`${GMAIL}/profile`, { headers: { Authorization: `Bearer ${token}` } }, 15_000);
    if (!res.ok) return { ok: false, error: `Gmail API: ${res.status} ${(await res.text()).slice(0, 200)}` };
    const p = await res.json();
    if (p.emailAddress?.toLowerCase() !== account.email.toLowerCase()) return { ok: false, error: 'Signed-in Google account does not match this email address' };
    return { ok: true, via: 'Gmail API (HTTPS)' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------- Amazon SES v2 API (SigV4) ----------------
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmacRaw = (key, s) => crypto.createHmac('sha256', key).update(s).digest();

/** AWS Signature Version 4. Exported for unit testing against AWS's published test vector. */
export function signV4({ method, host, path, query = '', headers, payload = '', region, service, accessKeyId, secretAccessKey, amzDate }) {
  const dateStamp = amzDate.slice(0, 8);
  const all = { ...headers, host, 'x-amz-date': amzDate };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, sha256hex(payload)].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmacRaw(`AWS4${secretAccessKey}`, dateStamp);
  k = hmacRaw(k, region); k = hmacRaw(k, service); k = hmacRaw(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  return {
    signature,
    headers: { ...all, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
  };
}

export function sesRegion(account) {
  return /^email\.([a-z0-9-]+)\.amazonaws\.com$/.exec(account.smtpHost)?.[1] || 'us-east-1';
}

async function sesRequest(account, method, path, body) {
  const region = sesRegion(account);
  const host = `email.${region}.amazonaws.com`;
  const payload = body ? JSON.stringify(body) : '';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const { headers } = signV4({
    method, host, path, payload, region, service: 'ses', amzDate,
    headers: { 'content-type': 'application/json' },
    accessKeyId: account.smtpUser, secretAccessKey: decryptSecret(account.smtpPassEnc),
  });
  delete headers.host;
  // Test-only endpoint override (e.g. a local mock). Never honoured in production.
  const base = process.env.NODE_ENV !== 'production' && process.env.SES_API_ENDPOINT ? process.env.SES_API_ENDPOINT : `https://${host}`;
  return httpsFetch(`${base}${path}`, { method, headers, body: payload || undefined });
}

async function sesSend(account, message) {
  const raw = await composeRaw(message);
  const res = await sesRequest(account, 'POST', '/v2/email/outbound-emails', { Content: { Raw: { Data: raw.toString('base64') } } });
  const text = await res.text();
  if (!res.ok) {
    // SES returns 400 for permanent problems (e.g. unverified sender in sandbox) and 429 for throttling.
    if (/AccountSuspended|SendingPaused|not authorized|InvalidClientTokenId|SignatureDoesNotMatch/i.test(text)) {
      throw httpError(403, text);
    }
    throw httpError(res.status, text);
  }
  const { MessageId } = JSON.parse(text);
  // SES replaces the Message-ID header with one derived from its own MessageId.
  return { messageId: `<${MessageId}@email.amazonses.com>`, providerMessageId: MessageId, response: `SES accepted id=${MessageId}` };
}

async function sesTest(account) {
  try {
    const res = await sesRequest(account, 'GET', '/v2/email/account');
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `SES API: ${res.status} ${text.slice(0, 200)}` };
    const a = JSON.parse(text);
    if (!a.SendingEnabled) return { ok: false, error: 'Sending is disabled on this SES account' };
    return {
      ok: true,
      via: 'Amazon SES API (HTTPS)',
      quota: { max24h: a.SendQuota?.Max24HourSend, maxPerSecond: a.SendQuota?.MaxSendRate, sandbox: !a.ProductionAccessEnabled },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------- dispatch ----------------
export async function deliver(account, message) {
  switch (transportKind(account)) {
    case 'GMAIL_API': return gmailSend(account, message);
    case 'SES_API': return sesSend(account, message);
    default: {
      const info = await smtpSend(account, message);
      return { messageId: message.messageId, providerMessageId: null, response: String(info?.response || '') };
    }
  }
}

export async function testSending(account) {
  switch (transportKind(account)) {
    case 'GMAIL_API': return gmailTest(account);
    case 'SES_API': return sesTest(account);
    default: {
      const r = await testSmtp(account);
      if (r.ok) return { ...r, via: 'SMTP' };
      const egress = await smtpEgress();
      if (egress.blockedPorts.includes(Number(account.smtpPort))) {
        return {
          ok: false,
          error: `This server cannot reach SMTP port ${account.smtpPort} (Render Free blocks outbound ports 25, 465 and 587). `
            + 'Use Google sign-in for Gmail/Workspace, the Amazon SES API, an SMTP relay on port 2525, or move the backend to a paid instance.',
          egressBlocked: true,
        };
      }
      return r;
    }
  }
}

export function closeAccountTransport(accountId) {
  closeTransport(accountId);
}

export { describeSmtpError };
