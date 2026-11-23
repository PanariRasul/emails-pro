/**
 * Check that this server can use Google Gemini, and say why not if it can't.
 *   npm run ai:check
 * Uses GEMINI_API_KEY / GEMINI_MODEL / GEMINI_THINKING_LEVEL from .env.
 * Makes at most 2 small AI requests (well inside the free tier). Never prints the key.
 */
const key = (process.env.GEMINI_API_KEY || "").trim();
const model = (process.env.GEMINI_MODEL || "gemini-flash-latest").trim();
const base = (
  process.env.GEMINI_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta"
).replace(/\/$/, "");
const lvl = (process.env.GEMINI_THINKING_LEVEL || "LOW").trim().toUpperCase();
const thinking = lvl === "OFF" || lvl === "NONE" ? "" : lvl;

const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✖ ${m}`);
const info = (m) => console.log(`    ${m}`);

function advice(status, err) {
  const msg = `${err?.status || ""} ${err?.message || ""} ${JSON.stringify(err?.details || "")}`;
  if (/ACCESS_TOKEN_TYPE_UNSUPPORTED|OAuth 2 access token/i.test(msg)) {
    return "Google rejected this AQ.-type key for the Gemini API. In aistudio.google.com → Get API key, create a key in a project where the Gemini API works (test it in AI Studio), or use a different Google account/project. This is a Google account issue, not an Emails Pro bug.";
  }
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(msg))
    return "The key is wrong. Copy it again from aistudio.google.com (no quotes or spaces) into GEMINI_API_KEY in .env, then restart the backend.";
  if (status === 401 || status === 403)
    return 'Google does not accept this key for the Gemini API. Check the key in aistudio.google.com, and that the "Generative Language API" is enabled for its project.';
  if (status === 404)
    return `The model "${model}" was not found for this key. Set GEMINI_MODEL=gemini-flash-lite-latest (or another model listed above) in .env and restart.`;
  if (status === 429 && /limit: 0/i.test(msg))
    return "This project has NO free-tier quota (limit: 0). Create the key in a new project in aistudio.google.com, or enable billing on the project.";
  if (status === 429)
    return "Free-tier limit reached right now. Wait a minute (or until 1:30 pm India time for the daily limit) and try again.";
  if (status >= 500)
    return "Google's servers are overloaded right now. Try again in a few minutes, or set GEMINI_MODEL=gemini-flash-lite-latest.";
  return "See Google's message above.";
}

async function call(path, init = {}, ms = 60_000) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(ms),
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": key,
        ...(init.headers || {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    return { res, body, ms: Date.now() - t0 };
  } catch (err) {
    return { err, ms: Date.now() - t0 };
  }
}

console.log("\nEmails Pro — Gemini check\n");

// 1. Key present?
if (!key) {
  bad(
    "GEMINI_API_KEY is empty. Add it to backend/.env (GEMINI_API_KEY=your-key) and run this again.",
  );
  process.exit(1);
}
ok(
  `GEMINI_API_KEY is set (starts with "${key.slice(0, 3)}…", ${key.length} characters)`,
);
if (/^["']|["']$|\s/.test(process.env.GEMINI_API_KEY || ""))
  info("⚠ The key has quotes or spaces around it in .env — remove them.");
info(`Model: ${model} · thinking level: ${thinking || "off"}`);

// 2. Can we reach Google at all?
const list = await call("/models?pageSize=100", { method: "GET" }, 20_000);
if (list.err) {
  bad(
    `Could not reach ${new URL(base).host} (${list.err.name === "TimeoutError" ? "no answer in 20 s" : list.err.message}).`,
  );
  info(
    "Check this computer's internet / firewall / VPN / proxy. On an office network, Google APIs may be blocked.",
  );
  process.exit(1);
}
ok(`Reached Google in ${list.ms} ms`);
if (!list.res.ok) {
  bad(
    `Google refused the key: HTTP ${list.res.status} — ${list.body?.error?.message || ""}`,
  );
  info(advice(list.res.status, list.body?.error));
  process.exit(1);
}
const names = (list.body.models || [])
  .filter((m) =>
    (m.supportedGenerationMethods || []).includes("generateContent"),
  )
  .map((m) => m.name.replace(/^models\//, ""));
ok(`Key accepted — ${names.length} models available`);
const flash = names.filter((n) => /flash/.test(n)).slice(0, 8);
if (flash.length) info(`Flash models: ${flash.join(", ")}`);
if (names.length && !names.includes(model) && !/latest$/.test(model))
  info(`⚠ "${model}" is not in the list above.`);

// 3. One tiny real request, the same way the app does it.
async function generate(level) {
  return call(`/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: 'Reply with JSON only: {"ok": true, "subject": "<a 4-word email subject about coffee>"}',
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2200,
        responseMimeType: "application/json",
        ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}),
      },
    }),
  });
}
let g = await generate(thinking);
if (
  !g.err &&
  g.res.status === 400 &&
  thinking &&
  /thinking/i.test(g.body?.error?.message || "")
) {
  info(
    `This model does not accept thinking level ${thinking} — trying without it (the app does this automatically).`,
  );
  g = await generate("");
}
if (g.err) {
  bad(`No answer from ${model} within 60 s (${g.err.name}).`);
  info(
    "Google is very slow for this model right now. Set GEMINI_MODEL=gemini-flash-lite-latest in .env and restart, or try again later.",
  );
  process.exit(1);
}
if (!g.res.ok) {
  bad(
    `${model} answered HTTP ${g.res.status} after ${g.ms} ms — ${g.body?.error?.message || ""}`,
  );
  info(advice(g.res.status, g.body?.error));
  process.exit(1);
}
const cand = g.body?.candidates?.[0];
const text = (cand?.content?.parts || [])
  .filter((p) => !p.thought)
  .map((p) => p.text || "")
  .join("");
ok(
  `${model} answered in ${(g.ms / 1000).toFixed(1)} s (finish: ${cand?.finishReason || "?"}, tokens: ${g.body?.usageMetadata?.totalTokenCount ?? "?"})`,
);
info(`Answer: ${text.slice(0, 160)}`);
if (g.ms > 25_000)
  info(
    "⚠ That is slow. GEMINI_MODEL=gemini-flash-lite-latest is usually much faster.",
  );
console.log(
  "\nAll good — the AI assistant should work. Restart the backend if you changed .env.\n",
);
