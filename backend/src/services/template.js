import sanitizeHtml from 'sanitize-html';
import { config } from '../config/index.js';
import { hmac, randomToken } from '../lib/crypto.js';
import { guessFromEmail } from '../lib/nameGuess.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Replace {{var}} placeholders. Values are HTML-escaped in HTML mode. Unknown or empty variables render empty,
 * or the fallback after "|": {{firstName|there}} → "there" when the first name is unknown.
 */
// Variable names people commonly type → the canonical name.
const ALIASES = {
  firstname: 'firstName', fname: 'firstName', first: 'firstName', givenname: 'firstName',
  lastname: 'lastName', lname: 'lastName', last: 'lastName', surname: 'lastName', familyname: 'lastName',
  name: 'fullName', fullname: 'fullName', contactname: 'fullName',
  company: 'companyName', companyname: 'companyName', organisation: 'companyName', organization: 'companyName', business: 'companyName', firm: 'companyName',
  email: 'email', emailaddress: 'email', mail: 'email',
  sender: 'senderName', sendername: 'senderName', fromname: 'senderName', myname: 'senderName', signature: 'senderName',
  senderemail: 'senderEmail', fromemail: 'senderEmail', myemail: 'senderEmail',
  employee: 'employeeName', employeename: 'employeeName',
};
const squash = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

function lookup(vars, key) {
  if (vars[key] !== undefined) return vars[key];
  const sq = squash(key);
  const alias = ALIASES[sq];
  if (alias && vars[alias] !== undefined) return vars[alias];
  // Custom CSV columns: match ignoring case, spaces and underscores ({{City}} = {{city}} = {{c_i_t_y}}).
  const hit = Object.keys(vars).find((k) => squash(k) === sq);
  return hit ? vars[hit] : undefined;
}

export function renderTemplate(tpl, vars, { html = false } = {}) {
  return String(tpl ?? '').replace(/\{\{\s*([a-zA-Z0-9_. -]+?)\s*(?:\|([^{}]*))?\}\}/g, (_, key, fallback) => {
    let v = lookup(vars, key.trim());
    if (v === undefined || v === null || String(v).trim() === '') {
      if (fallback === undefined) return '';
      v = fallback.trim(); // written by the employee in their own template; still escaped below
    }
    return html ? escapeHtml(v) : String(v).replace(/[\r\n]+/g, ' ');
  });
}

/** Sanitize email body HTML written by employees (keeps typical email markup and inline styles). */
export function sanitizeEmailHtml(html) {
  return sanitizeHtml(String(html ?? ''), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'span', 'center', 'font', 'h1', 'h2', 'u', 's']),
    allowedAttributes: {
      '*': ['style', 'align', 'width', 'height', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'valign', 'color'],
      a: ['href', 'name', 'target', 'title', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      font: ['face', 'size', 'color'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'cid'] },
    allowProtocolRelative: false,
  });
}

/** Sanitize inbound (received) HTML for safe display in the inbox. Strips images to avoid tracking pixels. */
export function sanitizeInboundHtml(html) {
  return sanitizeHtml(String(html ?? ''), {
    allowedTags: sanitizeHtml.defaults.allowedTags.filter((t) => t !== 'img'),
    allowedAttributes: { a: ['href', 'title'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }) },
  });
}

export function htmlToText(html) {
  const prepared = String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<\/li>/gi, '</li>')
    .replace(/<li\b[^>]*>\s*(<p\b[^>]*>)?/gi, '• ')
    .replace(/<(ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|h\d|ul|ol)>/gi, '\n\n')
    .replace(/<\/(div|li|tr)>/gi, '\n');
  return sanitizeHtml(prepared, {
    allowedTags: [], allowedAttributes: {},
  }).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function clickUrl(token, url) {
  const sig = hmac(`${token}|${url}`);
  return `${config.publicApiUrl}/t/c/${token}?u=${encodeURIComponent(url)}&s=${sig}`;
}

export function verifyClick(token, url, sig) {
  return hmac(`${token}|${url}`) === sig;
}

export function unsubscribeUrl(token) {
  return `${config.publicApiUrl}/u/${token}`;
}

export function openPixelUrl(token) {
  return `${config.publicApiUrl}/t/o/${token}.gif`;
}

function rewriteLinks(html, token) {
  return html.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (m, pre, q, url) => {
    if (url.startsWith(config.publicApiUrl)) return m; // don't wrap our own unsubscribe link
    return `${pre}${q}${escapeHtml(clickUrl(token, url.replace(/&amp;/g, '&')))}${q}`;
  });
}

export function makeMessageId(fromEmail) {
  const domain = String(fromEmail).split('@')[1] || 'emails-pro.local';
  return `<${Date.now().toString(36)}.${randomToken(12)}@${domain}>`;
}

/** The name used to sign emails from a mailbox: its "Sender name", else "First Last" from a first.last@ address, else the address itself. */
export function senderNameFor(account, owner) {
  if (account?.displayName?.trim()) return account.displayName.trim();
  if (account?.email) {
    const g = guessFromEmail(account.email);
    if (g.firstName && g.lastName) return `${g.firstName} ${g.lastName}`; // ravi.kumar@… → "Ravi Kumar"
    return account.email;
  }
  return owner?.name ?? '';
}

export function buildVars({ recipient, owner, account }) {
  const v = (recipient.vars && typeof recipient.vars === 'object') ? recipient.vars : {};
  // Missing names/company are guessed from the address (ravi.kumar@acme.com → Ravi / Kumar / Acme).
  const g = guessFromEmail(recipient.email);
  const pick = (...xs) => xs.find((x) => x !== undefined && x !== null && String(x).trim() !== '') ?? '';
  const firstName = pick(v.firstName, g.firstName);
  const lastName = pick(v.lastName, v.firstName ? '' : g.lastName);
  return {
    ...v,
    email: recipient.email,
    firstName,
    lastName,
    fullName: pick(v.fullName, [firstName, lastName].filter(Boolean).join(' ')),
    companyName: pick(v.companyName, v.company, g.company),
    company: pick(v.company, v.companyName, g.company),
    employeeName: owner?.name ?? '',
    senderName: senderNameFor(account, owner),
    senderEmail: account?.email ?? '',
  };
}

/**
 * Build a complete outgoing message for one recipient.
 * The unsubscribe mechanism (footer + RFC 8058 headers) is always included; only its styling is configurable.
 */
export function buildMessage({ campaign, recipient, account, owner, settings, messageId }) {
  const vars = buildVars({ recipient, owner, account });
  const unsub = unsubscribeUrl(recipient.token);
  const subjectTpl = recipient.subject || campaign.subject;
  const subject = renderTemplate(subjectTpl, vars).slice(0, 250);

  let html = renderTemplate(campaign.html, vars, { html: true });
  const footerVars = { ...vars, unsubscribeUrl: unsub };
  const footerHtml = renderTemplate(settings.footerHtml, footerVars, { html: true });
  const footerText = renderTemplate(settings.footerText, footerVars);

  if (settings.trackingEnabled) html = rewriteLinks(html, recipient.token);
  html = `${html}\n${footerHtml}`;
  if (settings.trackingEnabled) {
    html += `<img src="${openPixelUrl(recipient.token)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px" />`;
  }

  const textBody = campaign.text?.trim() ? campaign.text : htmlToText(campaign.html);
  const text = `${renderTemplate(textBody, vars)}\n\n--\n${footerText}`;

  const headers = {
    'List-Unsubscribe': `<${unsub}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };

  const msg = {
    from: account.displayName ? { name: account.displayName, address: account.email } : account.email,
    to: recipient.email,
    subject,
    html,
    text,
    messageId,
    headers,
  };
  if (recipient.inReplyTo) {
    msg.inReplyTo = recipient.inReplyTo;
    msg.references = recipient.references || recipient.inReplyTo;
  }
  return msg;
}