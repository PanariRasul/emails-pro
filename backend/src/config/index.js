// Central configuration. All values come from the process environment
// (set them in Render → Service → Environment). No secrets are hardcoded.
import crypto from "node:crypto";

const env = process.env;
const isProd = env.NODE_ENV === "production";

function required(name, fallbackForDev) {
  const v = env[name];
  if (v && v.trim()) return v.trim();
  if (!isProd && fallbackForDev !== undefined) return fallbackForDev;
  throw new Error(`Missing required environment variable: ${name}`);
}

function int(name, def) {
  const n = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(n) ? n : def;
}

function bool(name, def) {
  const v = env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

// Dev-only ephemeral secrets so `npm run dev` works without setup. Production requires real ones.
const devSecret = () => crypto.randomBytes(32).toString("base64");

export const config = Object.freeze({
  appName: "Emails Pro",
  version: env.APP_VERSION || env.RENDER_GIT_COMMIT?.slice(0, 7) || "1.0.0",
  isProd,
  port: int("PORT", 10000),
  host: "0.0.0.0",
  instanceId:
    env.RENDER_INSTANCE_ID ||
    `${process.pid}-${crypto.randomBytes(3).toString("hex")}`,

  // URLs
  // Public base URL of this API (used in tracking + unsubscribe links inside emails).
  publicApiUrl: (
    env.PUBLIC_API_URL ||
    env.RENDER_EXTERNAL_URL ||
    `http://localhost:${int("PORT", 10000)}`
  ).replace(/\/$/, ""),
  // Comma-separated list of allowed frontend origins for CORS.
  corsOrigins: (env.CORS_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean),

  // Secrets
  jwtSecret: required("JWT_SECRET", devSecret()),
  // 32-byte key, base64 encoded. Used for AES-256-GCM encryption of SMTP/IMAP credentials.
  encryptionKey: required("ENCRYPTION_KEY", devSecret()),
  // Optional previous key to support credential-key rotation.
  encryptionKeyPrevious: env.ENCRYPTION_KEY_PREVIOUS || null,
  trackingSecret: env.TRACKING_SECRET || required("JWT_SECRET", devSecret()),

  accessTokenTtlSec: int("ACCESS_TOKEN_TTL_SEC", 15 * 60),
  refreshTokenTtlDays: int("REFRESH_TOKEN_TTL_DAYS", 14),
  cookieSameSite: (
    env.COOKIE_SAMESITE || (isProd ? "none" : "lax")
  ).toLowerCase(),

  // Optional Redis (only if a suitable free Redis-compatible service is configured).
  redisUrl: env.REDIS_URL || null,

  // Worker
  runWorker: bool("RUN_WORKER", true),
  workerTickMs: int("WORKER_TICK_MS", 5000),
  workerIdleTickMs: int("WORKER_IDLE_TICK_MS", 60000),
  workerBatchSize: int("WORKER_BATCH_SIZE", 5),
  stuckSendingMinutes: int("STUCK_SENDING_MINUTES", 10),
  smtpTimeoutMs: int("SMTP_TIMEOUT_MS", 30000),
  // Development/testing only: allow plaintext SMTP/IMAP to a local test server. Ignored in production.
  smtpDevInsecure: !isProd && bool("SMTP_DEV_INSECURE", false),

  // Bootstrap first admin (only used when no admin exists).
  bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL || null,
  bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD || null,

  requestTimeoutMs: int("REQUEST_TIMEOUT_MS", 25000),

  // Frontend URL (used for SSO redirects). Defaults to the first CORS origin.
  appUrl: (
    env.APP_URL || (env.CORS_ORIGINS || "http://localhost:5173").split(",")[0]
  )
    .trim()
    .replace(/\/$/, ""),

  // System mailbox for login OTP / password-reset codes (see services/systemMail.js).
  // Brevo email API (HTTPS, works on Render Free): BREVO_API_KEY + a sender email verified in Brevo.
  brevo: {
    apiKey: (env.BREVO_API_KEY || "").trim(),
    baseUrl: (env.NODE_ENV !== "production" && env.BREVO_API_BASE
      ? env.BREVO_API_BASE
      : "https://api.brevo.com/v3"
    ).replace(/\/$/, ""),
  },
  systemMail: {
    user: (env.SYSTEM_MAIL_USER || "emailspro.otp@gmail.com").trim(),
    pass: (env.SYSTEM_MAIL_APP_PASSWORD || "").replace(/\s+/g, ""), // Gmail shows app passwords with spaces
    host: env.SYSTEM_MAIL_HOST || "smtp.gmail.com",
    port: int("SYSTEM_MAIL_PORT", 465),
    secure: bool("SYSTEM_MAIL_SECURE", int("SYSTEM_MAIL_PORT", 465) === 465),
    fromName: env.SYSTEM_MAIL_FROM_NAME || "Emails Pro",
  },
  // Google Gemini (AI assistant). Free tier works; limits are enforced in services/ai.js.
  gemini: {
    apiKey: (env.GEMINI_API_KEY || "").trim(),
    model: (env.GEMINI_MODEL || "gemini-flash-latest").trim(),
    baseUrl: (
      env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/$/, ""),
    // LOW keeps answers quick on "thinking" models; set GEMINI_THINKING_LEVEL=off for older models.
    thinkingLevel: (() => {
      const v = (env.GEMINI_THINKING_LEVEL || "LOW").trim().toUpperCase();
      return v === "OFF" || v === "NONE" ? "" : v;
    })(),
    timeoutMs: Math.max(10_000, Number(env.GEMINI_TIMEOUT_MS) || 60_000),
    // Used automatically when the main model is overloaded or out of free quota. Comma-separated; "off" = none.
    fallbackModels: (() => {
      const v = (
        env.GEMINI_FALLBACK_MODELS ??
        "gemini-flash-lite-latest,gemini-2.5-flash"
      ).trim();
      return /^(off|none)$/i.test(v)
        ? []
        : v
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean);
    })(),
  },
  logLevel: env.LOG_LEVEL || (isProd ? "info" : "debug"),
});

/** Can people outside this computer reach the tracking/unsubscribe links? (Not when they point to localhost.) */
export function trackingReachable(url = config.publicApiUrl) {
  return (
    !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(
      url,
    ) && !/\.local(:|\/|$)/i.test(url)
  );
}

export function validateConfig() {
  const key = Buffer.from(config.encryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must be 32 bytes, base64 encoded (generate with: openssl rand -base64 32)",
    );
  }
  if (config.isProd && config.jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters in production");
  }
  if (!["lax", "strict", "none"].includes(config.cookieSameSite)) {
    throw new Error("COOKIE_SAMESITE must be lax, strict or none");
  }
}
