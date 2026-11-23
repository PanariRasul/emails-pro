// AI assistant endpoints (employees). Every call is limited by services/ai.js to stay within Gemini's free tier.
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ah, badRequest, forbidden, notFound } from "../lib/errors.js";
import { validate } from "../middleware/common.js";
import { employeeOnly, requireAuth } from "../middleware/auth.js";
import { aiStatus, generate } from "../services/ai.js";
import { getSettings } from "../services/settings.js";
import {
  htmlToText,
  sanitizeEmailHtml,
  senderNameFor,
} from "../services/template.js";
import { audit } from "../services/audit.js";

export const aiRouter = Router();
aiRouter.use(requireAuth, employeeOnly);

const GUIDE = `You are an expert B2B cold-email coach helping a sales employee get more REPLIES (not opens).
Rules you always follow:
- Keep every placeholder in double curly braces EXACTLY as written, e.g. {{firstName}}, {{firstName|there}}, {{companyName}}, {{senderName}}. Never invent new placeholders and never fill them in.
- Never invent facts, numbers, clients, prices, guarantees or claims that are not in the text.
- Prefer short, plain, personal, honest writing: one clear idea, one simple question or call to action, no hype, no spam words, no ALL CAPS, at most one link.
- Answer in the same language as the email.
- Reply ONLY with valid JSON in the exact shape requested. No markdown, no commentary.`;

const clip = (s, n) => String(s || "").slice(0, n);
const bodyText = (html) => clip(htmlToText(html || ""), 5000);

aiRouter.get(
  "/status",
  ah(async (req, res) => res.json(await aiStatus(req.user.id))),
);

// Score a pitch (subject lines + body) and suggest improvements and new subject lines.
aiRouter.post(
  "/pitch-review",
  validate({
    body: z.object({
      subjects: z.array(z.string().max(250)).min(1).max(10),
      html: z.string().min(1).max(200_000),
    }),
  }),
  ah(async (req, res) => {
    const { subjects, html } = req.body;
    const text = bodyText(html);
    if (text.split(/\s+/).filter(Boolean).length < 5)
      throw badRequest("Write a little more of the email first");
    const prompt = `${GUIDE}

Review this cold email pitch. Score how likely it is to get a REPLY from a busy business person (0-100).
Score each subject line (0-100) with a one-sentence tip. List up to 3 strengths and up to 5 concrete improvements
(each one short sentence, most important first). Suggest 5 new subject lines (under 60 characters; you may use {{firstName}} or {{companyName}}).

Subject lines:
${subjects.map((s, i) => `${i + 1}. ${clip(s, 250)}`).join("\n")}

Email body:
"""
${text}
"""

JSON shape:
{"score": number, "summary": "one sentence", "subjects": [{"subject": "...", "score": number, "tip": "..."}], "strengths": ["..."], "improvements": ["..."], "subjectIdeas": ["..."]}`;
    const r = await generate({
      userId: req.user.id,
      prompt,
      maxOutputTokens: 1200,
      temperature: 0.4,
    });
    const num = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
    res.json({
      score: num(r.score),
      summary: clip(r.summary, 300),
      subjects: (Array.isArray(r.subjects) ? r.subjects : [])
        .slice(0, 10)
        .map((x, i) => ({
          subject: clip(x?.subject || subjects[i], 250),
          score: num(x?.score),
          tip: clip(x?.tip, 300),
        })),
      strengths: (Array.isArray(r.strengths) ? r.strengths : [])
        .slice(0, 3)
        .map((x) => clip(x, 300)),
      improvements: (Array.isArray(r.improvements) ? r.improvements : [])
        .slice(0, 5)
        .map((x) => clip(x, 300)),
      subjectIdeas: (Array.isArray(r.subjectIdeas) ? r.subjectIdeas : [])
        .slice(0, 5)
        .map((x) => clip(x, 120))
        .filter(Boolean),
      cached: Boolean(r.cached),
    });
  }),
);

const GOALS = {
  improve:
    "Improve it for more replies: clearer, more personal, one clear question at the end. Keep about the same length.",
  shorter:
    "Make it shorter: at most about 90 words, keep the key point and the question.",
  friendlier:
    "Make it warmer and more conversational, like a real person writing to one person.",
  formal: "Make it more professional and polite, still short and clear.",
  grammar:
    "Only fix grammar, spelling and punctuation. Do not change the meaning, tone or length.",
};

// Rewrite the pitch body. Returns sanitized HTML that keeps all {{variables}}.
aiRouter.post(
  "/improve-pitch",
  validate({
    body: z.object({
      html: z.string().min(1).max(200_000),
      goal: z.enum(Object.keys(GOALS)),
    }),
  }),
  ah(async (req, res) => {
    const text = bodyText(req.body.html);
    if (text.split(/\s+/).filter(Boolean).length < 5)
      throw badRequest("Write a little more of the email first");
    const prompt = `${GUIDE}

Rewrite this cold email body. Goal: ${GOALS[req.body.goal]}
Keep the greeting and the sign-off (with {{senderName}} or the existing signature).
Return simple HTML using only <p>, <br>, <ul>, <li>, <b>, <i> and <a href>. One <p> per paragraph.

Email body:
"""
${text}
"""

JSON shape: {"html": "<p>...</p>", "note": "one short sentence describing what changed"}`;
    const r = await generate({
      userId: req.user.id,
      prompt,
      maxOutputTokens: 1500,
      temperature: 0.7,
    });
    const out = sanitizeEmailHtml(String(r.html || ""));
    if (!out.replace(/<[^>]+>/g, "").trim())
      throw badRequest(
        "The AI did not return a usable rewrite. Please try again.",
      );
    // Never lose personalisation: warn if a variable from the original disappeared.
    const vars = (s) =>
      new Set(
        (String(s).match(/\{\{[^{}]+\}\}/g) || []).map((v) =>
          v.replace(/\s+/g, ""),
        ),
      );
    const missing = [...vars(req.body.html)].filter((v) => !vars(out).has(v));
    res.json({
      html: out,
      note: clip(r.note, 300),
      missing,
      cached: Boolean(r.cached),
    });
  }),
);

const INTENTS = {
  interested:
    "They seem interested: thank them, answer what they asked if the email shows it, and propose a next step (a short call) with a question about a suitable time.",
  meeting:
    "Propose a short call or meeting and ask which day/time suits them this week or next.",
  info: "They asked for more information: answer briefly and honestly with what is known from the conversation, offer to send details, and ask one follow-up question.",
  price:
    "They asked about price: thank them, say pricing depends on their needs, and ask one or two short questions to prepare a quote. Do not invent numbers.",
  decline:
    "They are not interested: thank them politely, confirm you will not follow up, and leave the door open without pressure.",
  wrong:
    "Wrong person: thank them and politely ask who would be the right person to talk to.",
  custom: "Write the reply following the employee's instructions.",
};

// Draft a reply to a received email. Sends the reply's text (not attachments) to Gemini — admin can switch this off.
aiRouter.post(
  "/reply-draft",
  validate({
    body: z.object({
      messageId: z.string().max(40),
      intent: z.enum(Object.keys(INTENTS)).default("interested"),
      notes: z.string().max(1000).optional(),
    }),
  }),
  ah(async (req, res) => {
    const s = await getSettings();
    if (!s.aiReplyAssist)
      throw forbidden(
        "AI reply drafts are switched off by your administrator.",
      );
    const msg = await prisma.emailMessage.findFirst({
      where: {
        id: req.body.messageId,
        ownerId: req.user.id,
        direction: "INBOUND",
        deletedAt: null,
      },
      include: { account: true },
    });
    if (!msg) throw notFound("Message");
    // Only the new part of their reply (quoted history removed) is sent.
    const lines = String(msg.text || htmlToText(msg.html || "")).split(/\r?\n/);
    const cut = lines.findIndex(
      (l) =>
        /^\s*>/.test(l) ||
        /^On\b.{3,200}\bwrote:\s*$/.test(l.trim()) ||
        /^-{2,}\s*Original Message/i.test(l.trim()),
    );
    const theirs = clip(
      (cut > 0 ? lines.slice(0, cut) : lines).join("\n").trim(),
      3000,
    );
    const sender = senderNameFor(msg.account, req.user);
    const prompt = `${GUIDE}

Write a reply email from ${JSON.stringify(sender)} to this message they received (subject: ${JSON.stringify(clip(msg.subject, 200))}).
What to do: ${INTENTS[req.body.intent]}
${req.body.notes ? `Employee's instructions: ${JSON.stringify(clip(req.body.notes, 1000))}` : ""}
Keep it short (40-120 words), friendly and professional, plain text with blank lines between paragraphs, signed "${sender}". Do not use placeholders.

Their message:
"""
${theirs}
"""

JSON shape: {"text": "the reply"}`;
    const r = await generate({
      userId: req.user.id,
      prompt,
      maxOutputTokens: 700,
      temperature: 0.7,
    });
    const text = clip(String(r.text || "").trim(), 5000);
    if (!text)
      throw badRequest("The AI did not return a reply. Please try again.");
    audit(req, "ai.reply_draft", "EmailMessage", msg.id);
    res.json({ text, cached: Boolean(r.cached) });
  }),
);
