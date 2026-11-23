/**
 * AI assistant on Google Gemini (works on the free tier).
 *
 * Free-tier protection — every call goes through `generate()`, which enforces, in this order:
 *   1. the admin switch (Settings → AI assistant) and a configured GEMINI_API_KEY;
 *   2. a per-minute limit (default 8/min, below the free tier's ~10/min);
 *   3. a per-day limit for the whole project (default 200/day, below the free tier's ~250/day;
 *      the day resets at midnight Pacific time, like Google's quota);
 *   4. a per-employee daily limit (default 30/day) so one person can't use everyone's allowance;
 *   5. a short cool-down after Google answers 429 (quota exceeded).
 * Identical questions are answered from a 6-hour cache and don't count again.
 * Counters live in Postgres (UsageCounter), so restarts and several instances can't overspend.
 */
import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { config } from "../config/index.js";
import { getSettings } from "./settings.js";
import { logger } from "../lib/logger.js";
import { HttpError as AppError } from "../lib/errors.js";

const CACHE_TTL = 6 * 3_600_000;
const cache = new Map(); // hash -> { at, value }
let cooldownUntil = 0;
let thinkingLevel = config.gemini.thinkingLevel; // '' = don't send (older models)

/** Start of the current Gemini quota day (midnight America/Los_Angeles) as a Date. */
export function pacificDayStart(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const offset = asUtc - Math.floor(now.getTime() / 1000) * 1000; // Pacific offset in ms
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - offset);
}
const minuteStart = (now = new Date()) =>
  new Date(Math.floor(now.getTime() / 60_000) * 60_000);

async function bump(scope, windowStart, limit) {
  const rows = await prisma.$queryRaw`
    INSERT INTO "UsageCounter" ("scope", "windowStart", "count") VALUES (${scope}, ${windowStart}, 1)
    ON CONFLICT ("scope", "windowStart") DO UPDATE SET "count" = "UsageCounter"."count" + 1
    WHERE "UsageCounter"."count" < ${limit}
    RETURNING "count"`;
  return rows.length > 0;
}
async function unbump(scope, windowStart) {
  await prisma.$executeRaw`UPDATE "UsageCounter" SET "count" = GREATEST(0, "count" - 1) WHERE "scope" = ${scope} AND "windowStart" = ${windowStart}`;
}
async function count(scope, windowStart) {
  const r = await prisma.usageCounter.findUnique({
    where: { scope_windowStart: { scope, windowStart } },
  });
  return r?.count || 0;
}

export async function aiStatus(userId) {
  const s = await getSettings();
  const day = pacificDayStart();
  const [usedToday, usedByMe] = await Promise.all([
    count("ai:day", day),
    userId ? count(`ai:user:${userId}:day`, day) : 0,
  ]);
  return {
    configured: Boolean(config.gemini.apiKey),
    enabled: s.aiEnabled && Boolean(config.gemini.apiKey),
    replyAssist: s.aiReplyAssist,
    model: config.gemini.model,
    perMinute: s.aiPerMinute,
    dailyLimit: s.aiDailyLimit,
    userDailyLimit: s.aiUserDailyLimit,
    usedToday,
    usedByMe,
    remainingForMe: Math.max(
      0,
      Math.min(s.aiUserDailyLimit - usedByMe, s.aiDailyLimit - usedToday),
    ),
    resetsAt: new Date(day.getTime() + 86_400_000),
  };
}

const busy = (msg) => new AppError(429, "AI_LIMIT", msg);

/** Reserve one AI request (minute, day, user). Throws a friendly 429 when a limit is reached. */
async function reserve(userId, s) {
  if (Date.now() < cooldownUntil)
    throw busy(
      `The AI assistant is resting for ${Math.ceil((cooldownUntil - Date.now()) / 1000)} s (Google free-tier limit). Try again shortly.`,
    );
  const day = pacificDayStart();
  const min = minuteStart();
  if (!(await bump("ai:minute", min, s.aiPerMinute)))
    throw busy(
      "The AI assistant is busy this minute. Try again in a few seconds.",
    );
  if (!(await bump("ai:day", day, s.aiDailyLimit))) {
    await unbump("ai:minute", min);
    throw busy(
      "Today's free AI allowance for the team is used up. It resets at midnight Pacific time (about 1:30 pm India time).",
    );
  }
  if (!(await bump(`ai:user:${userId}:day`, day, s.aiUserDailyLimit))) {
    await unbump("ai:minute", min);
    await unbump("ai:day", day);
    throw busy(
      `You've used your ${s.aiUserDailyLimit} AI requests for today. The score and tips still work without AI.`,
    );
  }
  return () =>
    Promise.all([
      unbump("ai:minute", min),
      unbump("ai:day", day),
      unbump(`ai:user:${userId}:day`, day),
    ]);
}

function extractJson(text) {
  const t = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* ignore */
    }
  }
  throw new AppError(
    502,
    "AI_BAD_ANSWER",
    "The AI gave an answer we could not read. Please try again.",
  );
}

/**
 * Ask Gemini and return parsed JSON. `prompt` must already contain everything the model needs.
 * Only the text in `prompt` is sent to Google.
 */
export async function generate({
  userId,
  prompt,
  maxOutputTokens = 900,
  temperature = 0.6,
}) {
  const s = await getSettings();
  if (!config.gemini.apiKey)
    throw new AppError(
      503,
      "AI_NOT_CONFIGURED",
      "The AI assistant is not set up yet: add GEMINI_API_KEY to the server settings.",
    );
  if (!s.aiEnabled)
    throw new AppError(
      403,
      "AI_DISABLED",
      "The AI assistant is switched off by your administrator.",
    );

  const key = crypto
    .createHash("sha256")
    .update(`${config.gemini.model}|${temperature}|${prompt}`)
    .digest("hex");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL)
    return { ...hit.value, cached: true };

  let release = await reserve(userId, s);
  let res;
  let body;
  let usedThinking = false;
  for (let attempt = 0; ; attempt += 1) {
    usedThinking = Boolean(thinkingLevel);
    try {
      ({ res, body } = await callGemini({
        prompt,
        temperature,
        maxOutputTokens,
      }));
    } catch (err) {
      const timedOut = err.name === "AbortError" || err.name === "TimeoutError";
      // A timed-out request may still have been counted by Google, so it stays counted here too.
      if (!timedOut) await release();
      logger.warn({ err: err.message, attempt }, "gemini request failed");
      throw new AppError(
        503,
        "AI_UNAVAILABLE",
        timedOut
          ? "Google's AI is slow right now and did not answer in time. Please try again in a minute."
          : "Could not reach the AI service. Please check the server's internet connection and try again.",
      );
    }
    // Newer "thinking" models accept thinkingLevel; older ones reject it with 400. Retry once without it (a 400 uses no quota).
    if (
      res.status === 400 &&
      usedThinking &&
      /thinking/i.test(body?.error?.message || "")
    ) {
      logger.warn(
        { error: body?.error?.message },
        "gemini model does not accept thinkingLevel; retrying without it",
      );
      thinkingLevel = "";
      continue;
    }
    // Google's servers are overloaded now and then on the free tier (500/503/504). Try once more after a short pause.
    if ([500, 503, 504].includes(res.status) && attempt === 0) {
      logger.warn(
        { status: res.status, error: body?.error?.message },
        "gemini overloaded; retrying once",
      );
      await release();
      await new Promise((r) => setTimeout(r, 2000));
      release = await reserve(userId, s);
      continue;
    }
    break;
  }
  if (res.status === 429) {
    // Google's own limit was hit (e.g. other apps on the same project): back off and don't count it.
    const retry =
      Number(
        String(
          body?.error?.details?.find?.((d) => d.retryDelay)?.retryDelay || "",
        ).replace(/s$/, ""),
      ) || 60;
    cooldownUntil = Date.now() + Math.min(300, Math.max(15, retry)) * 1000;
    await release();
    throw busy(
      "Google's free AI limit was reached. The assistant will be available again in about a minute.",
    );
  }
  if (!res.ok) {
    await release();
    logger.warn(
      { status: res.status, error: body?.error?.message },
      "gemini error",
    );
    if (
      /ACCESS_TOKEN_TYPE_UNSUPPORTED|OAuth 2 access token/i.test(
        JSON.stringify(body?.error || ""),
      )
    ) {
      throw new AppError(
        503,
        "AI_ERROR",
        'Google does not accept this Gemini key (ACCESS_TOKEN_TYPE_UNSUPPORTED). Create a new key in aistudio.google.com — run "npm run ai:check" in the backend folder for details.',
      );
    }
    if (
      res.status === 400 ||
      res.status === 401 ||
      res.status === 403 ||
      res.status === 404
    ) {
      throw new AppError(
        503,
        "AI_ERROR",
        `The AI key or model is not valid (Google said: ${String(body?.error?.message || res.status).slice(0, 160)}). Ask your administrator to check GEMINI_API_KEY / GEMINI_MODEL.`,
      );
    }
    throw new AppError(
      503,
      "AI_BUSY",
      "Google's AI is overloaded right now. Please try again in a minute — your pitch score and tips still work.",
    );
  }
  const cand = body?.candidates?.[0];
  const text =
    cand?.content?.parts
      ?.filter((p) => !p.thought)
      .map((p) => p.text || "")
      .join("") || "";
  if (!text) {
    logger.warn(
      {
        finishReason: cand?.finishReason,
        block: body?.promptFeedback?.blockReason,
      },
      "gemini empty answer",
    );
    throw new AppError(
      502,
      "AI_EMPTY",
      body?.promptFeedback?.blockReason || cand?.finishReason === "SAFETY"
        ? "The AI declined to answer this text."
        : "The AI returned no answer. Please try again.",
    );
  }
  let value;
  try {
    value = extractJson(text);
  } catch (err) {
    logger.warn(
      { finishReason: cand?.finishReason, length: text.length },
      "gemini answer was not valid JSON",
    );
    if (cand?.finishReason === "MAX_TOKENS")
      throw new AppError(
        502,
        "AI_TOO_LONG",
        "The AI answer was cut off. Try a shorter pitch, or press the button again.",
      );
    throw err;
  }
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}

/** One HTTPS call to Gemini. Thinking is kept low: these are short writing tasks, and deep thinking is slow and uses the output budget. */
async function callGemini({ prompt, temperature, maxOutputTokens }) {
  const generationConfig = {
    temperature,
    // Thinking tokens count towards maxOutputTokens, so leave room for them.
    maxOutputTokens: maxOutputTokens + (thinkingLevel ? 2048 : 0),
    responseMimeType: "application/json",
    ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
  };
  const res = await fetch(
    `${config.gemini.baseUrl}/models/${encodeURIComponent(config.gemini.model)}:generateContent`,
    {
      method: "POST",
      signal: AbortSignal.timeout(config.gemini.timeoutMs),
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": config.gemini.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig,
      }),
    },
  );
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

export const _testing = {
  reset: () => {
    cache.clear();
    cooldownUntil = 0;
    thinkingLevel = config.gemini.thinkingLevel;
  },
};
