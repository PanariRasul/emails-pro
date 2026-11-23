// System mailbox used for login OTP and password-reset codes (e.g. emailspro.otp@gmail.com).
//
// Three ways to send, checked in this order:
//  1. Gmail API — the admin connects the mailbox with Google sign-in (Admin → Policies & settings → Login security).
//     Uses HTTPS, so it works on Render Free.
//  2. Brevo email API — BREVO_API_KEY (+ SYSTEM_MAIL_FROM, a sender verified in Brevo). HTTPS, works on Render Free,
//     free plan 300 emails/day.
//  3. SMTP with an app password — SYSTEM_MAIL_USER + SYSTEM_MAIL_APP_PASSWORD (from .env locally, or Render env vars).
//     Uses port 465/587, which Render Free blocks; works locally and on paid instances.
import nodemailer from "nodemailer";
import { config } from "../config/index.js";
import { logger } from "../lib/logger.js";
import { getSettings } from "./settings.js";
import { deliver } from "./transports.js";
import { escapeHtml, makeMessageId } from "./template.js";

function brevoFrom() {
  return (process.env.SYSTEM_MAIL_FROM || config.systemMail.user || "")
    .trim()
    .toLowerCase();
}

async function sendViaBrevo(message) {
  let res;
  try {
    res = await fetch(`${config.brevo.baseUrl}/smtp/email`, {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "api-key": config.brevo.apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: message.from.name, email: message.from.address },
        to: [{ email: message.to }],
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
        headers: { "Message-ID": message.messageId },
        tags: ["emails-pro-system"],
      }),
    });
  } catch (err) {
    logger.warn({ err: err.message }, "brevo request failed");
    const e = new Error("Could not reach Brevo");
    e.code = "ECONNECTION";
    throw e;
  }
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  logger.warn(
    { status: res.status, code: body.code, error: body.message },
    "system mail send failed (brevo)",
  );
  const e = new Error(`Brevo: ${body.message || res.status}`);
  e.code =
    res.status === 401
      ? "BREVO_KEY"
      : /sender/i.test(body.message || "")
        ? "BREVO_SENDER"
        : "BREVO_ERROR";
  throw e;
}

export async function systemMailStatus() {
  const s = await getSettings();
  if (s.systemMailRefreshEnc && s.systemMailEmail) {
    return {
      configured: true,
      via: "GMAIL_API",
      from: s.systemMailEmail,
      note: "Connected with Google sign-in (Gmail API over HTTPS — works on Render Free).",
    };
  }
  if (config.brevo.apiKey) {
    return {
      configured: true,
      via: "BREVO",
      from: brevoFrom(),
      note: "Brevo email API over HTTPS — works on Render Free (free plan: 300 emails/day). The sender must be verified in Brevo → Senders.",
    };
  }
  if (config.systemMail.user && config.systemMail.pass) {
    return {
      configured: true,
      via: "SMTP",
      from: config.systemMail.user,
      note: `SMTP ${config.systemMail.host}:${config.systemMail.port} with an app password. Render Free blocks SMTP ports — connect the mailbox with Google for hosted use.`,
    };
  }
  return {
    configured: false,
    via: null,
    from: config.systemMail.user || null,
    note: "Not configured. Connect the OTP mailbox with Google, or set SYSTEM_MAIL_APP_PASSWORD.",
  };
}

function layout({ title, intro, code, footer }) {
  const c = escapeHtml(code);
  return `<!doctype html><html><body style="margin:0;background:#f3f5fb;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e5e9f2">
<tr><td style="background:linear-gradient(135deg,#0b1a4a,#1d4ed8);padding:22px 28px;color:#fff;font-size:20px;font-weight:700;font-family:Georgia,serif">Emails <i style="color:#7cc4ff">Pro</i></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 8px;font-size:20px">${escapeHtml(title)}</h1>
<p style="margin:0 0 20px;color:#475569;font-size:14px;line-height:1.5">${escapeHtml(intro)}</p>
<div style="font-size:34px;letter-spacing:10px;font-weight:700;text-align:center;background:#eef3ff;color:#1d4ed8;border-radius:12px;padding:16px 0">${c}</div>
<p style="margin:20px 0 0;color:#64748b;font-size:12px;line-height:1.5">${escapeHtml(footer)}</p>
</td></tr></table>
<p style="color:#94a3b8;font-size:11px;margin-top:16px">Emails Pro · Email Marketing Platform</p>
</td></tr></table></body></html>`;
}

export function codeEmail({ purpose, code, name, minutes }) {
  const login = purpose === "LOGIN";
  const title = login ? "Your sign-in code" : "Reset your password";
  const intro = login
    ? `Hi ${name || "there"}, use this code to finish signing in to Emails Pro.`
    : `Hi ${name || "there"}, use this code to choose a new Emails Pro password.`;
  const footer = `The code expires in ${minutes} minutes and can be used once. If you didn't request it, you can ignore this email — your account stays safe${login ? ", but consider changing your password" : ""}.`;
  return {
    subject: login
      ? `${code} is your Emails Pro sign-in code`
      : `${code} is your Emails Pro password reset code`,
    text: `${title}\n\n${intro}\n\n${code}\n\n${footer}`,
    html: layout({ title, intro, code, footer }),
  };
}

export async function sendSystemMail({ to, subject, text, html }) {
  const status = await systemMailStatus();
  if (!status.configured) {
    const e = new Error("The system mailbox is not configured");
    e.code = "MAIL_NOT_CONFIGURED";
    throw e;
  }
  const from = { name: config.systemMail.fromName, address: status.from };
  const message = {
    from,
    to,
    subject,
    text,
    html,
    messageId: makeMessageId(status.from),
  };
  if (status.via === "GMAIL_API") {
    const s = await getSettings();
    await deliver(
      {
        id: "system-mailer",
        authType: "OAUTH2",
        email: s.systemMailEmail,
        oauthRefreshEnc: s.systemMailRefreshEnc,
      },
      message,
    );
    return status.via;
  }
  if (status.via === "BREVO") {
    await sendViaBrevo(message);
    return status.via;
  }
  const insecure = config.smtpDevInsecure;
  const t = nodemailer.createTransport({
    host: config.systemMail.host,
    port: config.systemMail.port,
    secure: config.systemMail.secure,
    requireTLS: !config.systemMail.secure && !insecure,
    ignoreTLS: insecure && !config.systemMail.secure,
    auth: { user: config.systemMail.user, pass: config.systemMail.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  try {
    await t.sendMail(message);
  } catch (err) {
    logger.warn(
      { err: err.message, code: err.code },
      "system mail send failed",
    );
    throw err;
  } finally {
    t.close();
  }
  return status.via;
}
