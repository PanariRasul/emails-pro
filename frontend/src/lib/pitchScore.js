/**
 * Instant "reply score" for a pitch: runs in the browser on every keystroke, no AI needed.
 * Based on common cold-email findings: short, plain, personal emails that end with one clear
 * question get more replies; hype, spam words, many links, images and long paragraphs get fewer.
 */

const SPAM = [
  "free",
  "guarantee",
  "guaranteed",
  "urgent",
  "act now",
  "limited time",
  "winner",
  "cash",
  "click here",
  "buy now",
  "risk-free",
  "risk free",
  "no cost",
  "100%",
  "earn money",
  "make money",
  "extra income",
  "cheap",
  "lowest price",
  "best price",
  "special offer",
  "exclusive deal",
  "once in a lifetime",
  "congratulations",
  "dear friend",
  "amazing",
  "incredible",
  "miracle",
  "double your",
  "increase sales by",
  "call now",
  "order now",
  "apply now",
  "instant",
  "hurry",
  "last chance",
  "expires",
  "unsubscribe",
  "$$$",
  "₹₹",
  "credit",
  "loan",
  "investment",
  "bonus",
];
const VAR_RE = /\{\{\s*[\w. ]+?\s*(\|[^{}]*)?\}\}/g;

const strip = (html) =>
  String(html || "")
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');

const words = (t) =>
  (t.match(/[\p{L}\p{N}'’{}|_.-]+/gu) || []).filter((w) =>
    /[\p{L}\p{N}]/u.test(w),
  );
const spamHits = (t) => {
  const l = ` ${t.toLowerCase()} `;
  return SPAM.filter((w) =>
    l.includes(w.length <= 4 && /^[a-z]+$/.test(w) ? ` ${w} ` : w),
  );
};
const capsWords = (t) =>
  (t.replace(VAR_RE, "").match(/\b[A-Z]{4,}\b/g) || []).filter(
    (w) =>
      !/^(HTML|SaaS|CEO|CRM|SEO|API|USA|INDIA|LLC|GST|ERP|B2B|PDF|FAQ)$/i.test(
        w,
      ),
  );
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

export function grade(score) {
  if (score >= 80) return { label: "Great", color: "emerald", hex: "#10b981" };
  if (score >= 60) return { label: "Good", color: "blue", hex: "#3b82f6" };
  if (score >= 40)
    return { label: "Needs work", color: "amber", hex: "#f59e0b" };
  return { label: "Weak", color: "red", hex: "#ef4444" };
}

export function scoreSubject(subject) {
  const s = String(subject || "").trim();
  const checks = [];
  let score = 100;
  const add = (ok, label, tip, penalty = 0) => {
    checks.push({ ok, label, tip });
    if (!ok) score -= penalty;
  };
  if (!s)
    return {
      score: 0,
      checks: [
        {
          ok: false,
          label: "Subject is empty",
          tip: "Write a short subject line.",
        },
      ],
    };
  const shown = s.replace(VAR_RE, "Xxxxxxx"); // variables become ~7 characters when sent
  const len = shown.length;
  const w = words(shown).length;
  add(
    len >= 15 && len <= 55,
    `Length ${len} characters`,
    len < 15
      ? "A little longer helps: 3–7 words that say why you write."
      : "Shorter is better: under ~55 characters shows fully on phones.",
    len > 80 ? 30 : len > 55 ? 15 : 12,
  );
  add(
    w >= 2 && w <= 9,
    `${w} word${w === 1 ? "" : "s"}`,
    "Aim for 3–7 words.",
    8,
  );
  add(
    VAR_RE.test(s),
    "Personalised",
    "Add {{firstName}} or {{companyName}} — personal subjects get more opens.",
    10,
  );
  VAR_RE.lastIndex = 0;
  const caps = capsWords(s);
  add(
    !caps.length,
    "No shouting",
    `Avoid ALL CAPS (${caps.slice(0, 3).join(", ")}).`,
    15,
  );
  const bangs = (s.match(/!/g) || []).length;
  add(
    bangs === 0,
    "No exclamation marks",
    "Remove “!” — it looks like an advert.",
    bangs > 1 ? 20 : 10,
  );
  const spam = spamHits(s);
  add(
    !spam.length,
    "No spam words",
    `Avoid words like “${spam.slice(0, 3).join("”, “")}” — they trigger spam filters.`,
    15 * Math.min(2, spam.length),
  );
  add(
    !/^\s*(re|fw|fwd)\s*:/i.test(s),
    "Honest subject",
    "Don’t fake “Re:” or “Fwd:” on a first email — it hurts trust.",
    25,
  );
  add(
    !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s),
    "No emoji",
    "Emoji in business subjects often look like marketing.",
    5,
  );
  add(
    !/^[^a-z]*$/.test(s.replace(VAR_RE, "")) || s.length < 4,
    "Normal capitalisation",
    "Write it like a normal sentence, not Title Case or capitals.",
    0,
  );
  return { score: clamp(score), checks };
}

export function scoreBody(html) {
  const raw = String(html || "");
  const text = strip(raw);
  const all = words(text);
  const n = all.length;
  const checks = [];
  let score = 100;
  const add = (ok, label, tip, penalty = 0, id = label) => {
    checks.push({ id, ok, label, tip });
    if (!ok) score -= penalty;
  };
  if (n < 5)
    return {
      score: 0,
      words: n,
      checks: [
        {
          ok: false,
          label: "Email is empty",
          tip: "Write your message, or start from a template.",
        },
      ],
    };

  add(
    n >= 40 && n <= 150,
    `${n} words`,
    n < 40
      ? "A bit short: add one sentence on why it matters to them."
      : n <= 200
        ? "Shorter emails get more replies — aim for 50–125 words."
        : "Too long for a first email: cut it to 50–125 words.",
    n > 250 ? 30 : n > 200 ? 20 : n > 150 ? 10 : 10,
  );
  add(
    /\{\{\s*(first ?name|firstname|name|full ?name)/i.test(raw),
    "Uses their name",
    "Start with “Hi {{firstName|there}},”.",
    10,
  );
  add(
    /\{\{\s*(company|companyname|organi[sz]ation)/i.test(raw) ||
      /\{\{\s*(?!first|last|full|sender|employee|email|unsubscribe)[\w]+/i.test(
        raw,
      ),
    "Personal detail",
    "Mention something about them: {{companyName}}, their city or industry.",
    8,
  );
  const tail = text.trim().slice(-Math.max(160, Math.floor(text.length * 0.4)));
  add(
    /\?/.test(tail),
    "Ends with a question",
    "Finish with ONE easy question, e.g. “Would a 10-minute call next week help?”",
    15,
  );
  const links =
    (raw.match(/<a\s[^>]*href=/gi) || []).length +
    (text.match(/https?:\/\/\S+|www\.\S+/gi) || []).length -
    (
      raw.match(
        /<a\s[^>]*href=["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>\s*\1\s*<\/a>/gi,
      ) || []
    ).length;
  add(
    links <= 1,
    `${Math.max(0, links)} link${links === 1 ? "" : "s"}`,
    "Use at most one link — more links look like marketing and land in spam.",
    links >= 3 ? 20 : 10,
  );
  const imgs = (raw.match(/<img\b/gi) || []).length;
  add(
    imgs === 0,
    "No images",
    "Plain text emails reach the inbox more often — remove images.",
    10,
  );
  const spam = [...new Set(spamHits(text))];
  add(
    !spam.length,
    "No spam words",
    `Rephrase: “${spam.slice(0, 4).join("”, “")}”.`,
    Math.min(25, 8 * spam.length),
  );
  const bangs = (text.match(/!/g) || []).length;
  add(
    bangs <= 1,
    "Calm tone",
    "Use fewer “!” — one at most.",
    bangs > 3 ? 12 : 6,
  );
  const caps = capsWords(text);
  add(
    !caps.length,
    "No shouting",
    `Avoid ALL CAPS words (${caps.slice(0, 3).join(", ")}).`,
    8,
  );
  const paras = text
    .split(/\n\s*\n|\n/)
    .map((p) => words(p).length)
    .filter(Boolean);
  const longest = Math.max(0, ...paras);
  add(
    longest <= 50,
    "Short paragraphs",
    `Break up long paragraphs (one has ${longest} words) — 1–3 sentences each read better on phones.`,
    8,
  );
  const sentences = text
    .split(/[.!?]+\s/)
    .map((x) => words(x).length)
    .filter((x) => x > 0);
  const avg = sentences.length
    ? sentences.reduce((a, b) => a + b, 0) / sentences.length
    : 0;
  add(avg <= 22, "Easy to read", "Use shorter sentences (under ~20 words).", 6);
  const you = (text.match(/\b(you|your|yours)\b/gi) || []).length;
  const we = (text.match(/\b(we|our|us|i|my|me)\b/gi) || []).length;
  add(
    you >= we * 0.6,
    "About them, not you",
    "Talk more about them (“you/your”) than about yourself (“we/our”).",
    6,
  );
  add(
    /\b(hi|hello|dear|hey|good (morning|afternoon|evening)|namaste)\b/i.test(
      text.slice(0, 80),
    ),
    "Friendly greeting",
    "Start with a greeting like “Hi {{firstName|there}},”.",
    5,
  );
  add(
    /\{\{\s*sender\s*name|\{\{\s*sendername|regards|thanks|best|cheers|sincerely/i.test(
      raw,
    ),
    "Signed",
    "Sign off with your name, e.g. “Regards, {{senderName}}”.",
    5,
  );
  return { score: clamp(score), words: n, checks };
}

/** Overall reply score: 30% best subject line, 70% body. */
export function scorePitch({ subjects = [], html = "" }) {
  const subs = subjects
    .filter((s) => String(s).trim())
    .map((s) => ({ subject: s, ...scoreSubject(s) }));
  const body = scoreBody(html);
  const best = subs.length ? Math.max(...subs.map((s) => s.score)) : 0;
  const score = clamp(best * 0.3 + body.score * 0.7);
  const tips = [
    ...body.checks.filter((c) => !c.ok),
    ...(subs[0]?.checks || []).filter((c) => !c.ok),
  ]
    .slice(0, 4)
    .map((c) => c.tip);
  return { score, grade: grade(score), subjects: subs, body, tips };
}
