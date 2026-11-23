import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Reply, Send, Sparkles, X } from "lucide-react";
import { get, post } from "../api/client.js";
import { Button, cx, toast } from "./ui.jsx";
import RichEditor from "./RichEditor.jsx";
import { plainTextToHtml } from "../lib/pitchFormat.js";
import { guessFromEmail } from "../lib/nameGuess.js";

const QUICK = [
  [
    "Let’s talk",
    (n) =>
      `Hi ${n},\n\nThanks for getting back to me! Would a short 10-minute call this week work for you? Let me know a day and time that suits you.\n\nBest regards,`,
  ],
  [
    "Send details",
    (n) =>
      `Hi ${n},\n\nThanks for your interest. I'll send you the details shortly — is there anything specific you'd like me to include?\n\nBest regards,`,
  ],
  [
    "Thank you",
    (n) =>
      `Hi ${n},\n\nThank you for your reply — much appreciated.\n\nBest regards,`,
  ],
  [
    "Not now — noted",
    (n) =>
      `Hi ${n},\n\nThanks for letting me know. I won't follow up further, but feel free to reach out if anything changes.\n\nAll the best,`,
  ],
];
const AI_INTENTS = [
  ["interested", "They’re interested"],
  ["meeting", "Propose a meeting"],
  ["info", "Answer a question"],
  ["price", "They asked for price"],
  ["decline", "They said no"],
  ["wrong", "Wrong person"],
];

/** Reply in the same thread from the same mailbox, with quick replies and an optional AI draft. */
export default function ReplyBox({ message, onSent }) {
  const [open, setOpen] = useState(false);
  const [init, setInit] = useState({ html: "", key: 0 });
  const [html, setHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [aiMenu, setAiMenu] = useState(false);
  const [notes, setNotes] = useState("");
  const ai = useQuery({
    queryKey: ["ai-status"],
    queryFn: () => get("/api/ai/status"),
    staleTime: 60_000,
    enabled: open,
  });
  const g = guessFromEmail(message.fromAddr);
  const name = g.firstName || "there";
  const signature = message.account.displayName || message.account.email;

  const fill = (text) => {
    setInit((s) => ({ html: plainTextToHtml(text), key: s.key + 1 }));
    setOpen(true);
  };
  const quick = (fn) => fill(`${fn(name)}\n${signature}`);
  const draft = async (intent) => {
    setAiMenu(false);
    setDrafting(true);
    setOpen(true);
    try {
      const r = await post(
        "/api/ai/reply-draft",
        {
          messageId: message.id,
          intent: notes.trim() ? "custom" : intent,
          notes: notes.trim()
            ? `${AI_INTENTS.find(([k]) => k === intent)?.[1]}. ${notes.trim()}`
            : undefined,
        },
        { timeoutMs: 75_000 },
      );
      fill(r.text);
    } catch (err) {
      toast.error(err);
    } finally {
      setDrafting(false);
      ai.refetch();
    }
  };
  const send = async () => {
    setSending(true);
    try {
      await post(`/api/inbox/${message.id}/reply`, { html });
      toast.ok(`Reply sent from ${message.account.email}`);
      setOpen(false);
      setInit((s) => ({ html: "", key: s.key + 1 }));
      setHtml("");
      onSent?.();
    } catch (err) {
      toast.error(err);
    } finally {
      setSending(false);
    }
  };

  if (message.isBounce) return null;
  if (!open) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {QUICK.map(([label, fn]) => (
            <button
              key={label}
              type="button"
              onClick={() => quick(fn)}
              className="rounded-full border border-line bg-card px-3 py-1.5 text-xs font-medium text-fg2 transition hover:border-brand-400 hover:text-fg"
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setInit((s) => ({
              html: plainTextToHtml(
                `Hi ${name},\n\n\n\nBest regards,\n${signature}`,
              ),
              key: s.key + 1,
            }));
            setOpen(true);
          }}
          className="flex w-full items-center gap-3 rounded-full bg-subtle px-5 py-3 text-left text-sm text-muted transition hover:bg-subtle-2"
        >
          <Reply className="h-4 w-4" />
          Reply to {message.fromAddr}…
        </button>
      </div>
    );
  }
  const aiReady = ai.data?.enabled && ai.data?.replyAssist;
  return (
    <div className="space-y-2 rounded-3xl border border-line bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted">
        <span>
          From <b className="text-fg2">{message.account.email}</b> · in the same
          thread
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-full p-1 hover:bg-subtle"
          aria-label="Close reply"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <RichEditor
        initialHtml={init.html}
        resetKey={`reply-${message.id}-${init.key}`}
        onChange={setHtml}
        minHeight={150}
        placeholder="Write your reply…"
      />
      <div className="flex flex-wrap items-center gap-2">
        {aiReady && (
          <div className="relative">
            <Button
              size="sm"
              variant="secondary"
              icon={Sparkles}
              loading={drafting}
              onClick={() => setAiMenu((v) => !v)}
            >
              Draft with AI <ChevronDown className="ml-1 inline h-3 w-3" />
            </Button>
            {aiMenu && (
              <div className="absolute bottom-full left-0 z-30 mb-2 w-72 animate-pop rounded-2xl border border-line bg-card p-2 shadow-xl">
                <div className="px-2 pb-1 text-xs text-muted">
                  What should the reply do?
                </div>
                {AI_INTENTS.map(([k, l]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => draft(k)}
                    className="block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-subtle"
                  >
                    {l}
                  </button>
                ))}
                <input
                  className="input mt-1 h-9 text-xs"
                  placeholder="Extra instructions (optional)"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
                <div className="px-2 pt-1 text-[11px] text-muted">
                  {ai.data.remainingForMe} AI requests left today · their
                  message text is sent to Google Gemini
                </div>
              </div>
            )}
          </div>
        )}
        <span
          className={cx("ml-auto text-xs text-muted", !html && "opacity-0")}
        >
          Check the text before sending
        </span>
        <Button
          variant="brand"
          icon={Send}
          loading={sending}
          disabled={!html.replace(/<[^>]+>|&nbsp;/g, "").trim()}
          onClick={send}
        >
          Send reply
        </Button>
      </div>
    </div>
  );
}
