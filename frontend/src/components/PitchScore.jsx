import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Lightbulb,
  Plus,
  Sparkles,
  Wand2,
} from "lucide-react";
import { get, post } from "../api/client.js";
import { Button, Modal, cx, toast } from "./ui.jsx";
import EmailFrame from "./EmailFrame.jsx";
import { grade } from "../lib/pitchScore.js";

export function ScoreRing({ score, size = 40, stroke = 4, label = true }) {
  const g = grade(score);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-line"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={g.hex}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
          style={{ transition: "stroke-dashoffset .5s ease" }}
        />
      </svg>
      {label && (
        <span
          className="absolute text-[11px] font-bold tabular-nums text-fg"
          style={{ fontSize: size < 36 ? 10 : size > 60 ? 20 : 12 }}
        >
          {score}
        </span>
      )}
    </span>
  );
}

/** Compact live score button shown in editors. */
export function ScoreChip({ result, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="See how to get more replies"
      className="inline-flex items-center gap-2 rounded-full border border-line bg-card py-1 pr-3 pl-1 text-left transition hover:border-brand-400 hover:shadow-sm"
    >
      <ScoreRing score={result.score} size={30} stroke={3.5} />
      <span className="leading-tight">
        <span className="block text-[10px] text-muted">Reply score</span>
        <span
          className="block text-xs font-semibold"
          style={{ color: result.grade.hex }}
        >
          {result.grade.label}
        </span>
      </span>
    </button>
  );
}

function Check1({ c }) {
  return (
    <li className="flex items-start gap-2 py-1 text-sm">
      {c.ok ? (
        <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      )}
      <span className="min-w-0">
        <span className={cx(c.ok ? "text-fg2" : "font-medium text-fg")}>
          {c.label}
        </span>
        {!c.ok && <span className="block text-xs text-muted">{c.tip}</span>}
      </span>
    </li>
  );
}

const REWRITES = [
  ["improve", "Improve for replies"],
  ["shorter", "Make shorter"],
  ["friendlier", "Friendlier"],
  ["formal", "More formal"],
  ["grammar", "Fix grammar"],
];

/**
 * Score details + AI assistant (Gemini). `onApplySubject(text)` adds a subject line; `onApplyHtml(html)` replaces the body.
 */
export function ScorePanel({
  open,
  onClose,
  result,
  subjects,
  html,
  onApplySubject,
  onApplyHtml,
}) {
  const ai = useQuery({
    queryKey: ["ai-status"],
    queryFn: () => get("/api/ai/status"),
    staleTime: 30_000,
    enabled: open,
  });
  const [review, setReview] = useState(null);
  const [rewrite, setRewrite] = useState(null);
  const [busy, setBusy] = useState(null);
  const status = ai.data;
  const run = async (kind, fn) => {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
      ai.refetch();
    }
  };
  const doReview = () =>
    run("review", async () =>
      setReview(
        await post(
          "/api/ai/pitch-review",
          { subjects: subjects.filter((s) => s.trim()), html },
          { timeoutMs: 75_000 },
        ),
      ),
    );
  const doRewrite = (goal) =>
    run(goal, async () =>
      setRewrite({
        goal,
        ...(await post(
          "/api/ai/improve-pitch",
          { html, goal },
          { timeoutMs: 75_000 },
        )),
      }),
    );
  const failing = result.body.checks.filter((c) => !c.ok);

  return (
    <Modal open={open} onClose={onClose} size="xl" title="Reply score">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-5">
          <div className="flex items-center gap-4 rounded-3xl bg-subtle p-4">
            <ScoreRing score={result.score} size={76} stroke={7} />
            <div>
              <div
                className="text-lg font-semibold"
                style={{ color: result.grade.hex }}
              >
                {result.grade.label}
              </div>
              <p className="text-sm text-muted">
                {result.score >= 80
                  ? "This pitch follows what gets replies. Send a test and go!"
                  : "Fix the points below to get more replies."}
              </p>
            </div>
          </div>
          {result.tips.length > 0 && (
            <div className="rounded-2xl border border-amber-300/60 bg-amber-500/10 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-amber-800 dark:text-amber-200">
                <Lightbulb className="h-4 w-4" />
                Top things to fix
              </div>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-fg">
                {result.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ol>
            </div>
          )}
          <div>
            <div className="label">Subject lines</div>
            <div className="space-y-2">
              {result.subjects.length === 0 && (
                <p className="text-sm text-muted">Add a subject line.</p>
              )}
              {result.subjects.map((s, i) => (
                <div
                  key={`${s.subject}-${i}`}
                  className="rounded-2xl border border-line p-3"
                >
                  <div className="flex items-center gap-3">
                    <ScoreRing score={s.score} size={32} stroke={3.5} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {s.subject}
                    </span>
                  </div>
                  {s.checks.some((c) => !c.ok) && (
                    <ul className="mt-1 pl-1">
                      {s.checks
                        .filter((c) => !c.ok)
                        .map((c) => (
                          <Check1 key={c.label} c={c} />
                        ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="label">
              Email body · {result.body.words || 0} words
            </div>
            <ul>
              {[...failing, ...result.body.checks.filter((c) => c.ok)].map(
                (c) => (
                  <Check1 key={c.label} c={c} />
                ),
              )}
            </ul>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-3xl border border-line p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold">
                <Sparkles className="h-4 w-4 text-brand-500" />
                AI assistant
              </div>
              {status?.enabled && (
                <span className="text-xs text-muted">
                  {status.remainingForMe} AI request
                  {status.remainingForMe === 1 ? "" : "s"} left today
                </span>
              )}
            </div>
            {!status ? (
              <p className="mt-2 text-sm text-muted">Checking…</p>
            ) : !status.configured ? (
              <p className="mt-2 text-sm text-muted">
                Not set up yet. Your administrator adds a free Google Gemini key
                (GEMINI_API_KEY) to switch this on. The score and tips on the
                left work without it.
              </p>
            ) : !status.enabled ? (
              <p className="mt-2 text-sm text-muted">
                Switched off by your administrator.
              </p>
            ) : (
              <>
                <p className="mt-1 text-xs text-muted">
                  Gemini reads your pitch (with {"{{placeholders}}"}, not your
                  clients’ data) and suggests improvements.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="brand"
                    icon={Sparkles}
                    loading={busy === "review"}
                    disabled={Boolean(busy)}
                    onClick={doReview}
                  >
                    AI review & subject ideas
                  </Button>
                </div>
                <div className="mt-3 text-xs font-medium text-fg2">
                  Rewrite the email:
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {REWRITES.map(([g, l]) => (
                    <Button
                      key={g}
                      size="sm"
                      variant="secondary"
                      icon={Wand2}
                      loading={busy === g}
                      disabled={Boolean(busy)}
                      onClick={() => doRewrite(g)}
                    >
                      {l}
                    </Button>
                  ))}
                </div>
                {busy && (
                  <p className="mt-2 text-xs text-muted" role="status">
                    Gemini is working on it — this usually takes 5–20 seconds on
                    the free plan.
                  </p>
                )}
              </>
            )}
          </div>

          {review && (
            <div className="rounded-3xl border border-line p-4">
              <div className="flex items-center gap-3">
                <ScoreRing score={review.score} size={44} stroke={4.5} />
                <div>
                  <div className="text-sm font-semibold">AI score</div>
                  <div className="text-xs text-muted">{review.summary}</div>
                </div>
              </div>
              {review.strengths?.length > 0 && (
                <>
                  <div className="label mt-3">Good</div>
                  <ul className="list-disc space-y-0.5 pl-5 text-sm">
                    {review.strengths.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </>
              )}
              {review.improvements?.length > 0 && (
                <>
                  <div className="label mt-3">Improve</div>
                  <ol className="list-decimal space-y-0.5 pl-5 text-sm">
                    {review.improvements.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ol>
                </>
              )}
              {review.subjects?.some((s) => s.tip) && (
                <>
                  <div className="label mt-3">Subject feedback</div>
                  <ul className="space-y-1 text-sm">
                    {review.subjects.map((s) => (
                      <li key={s.subject}>
                        <b className="tabular-nums">{s.score}</b> · {s.subject}
                        <span className="block text-xs text-muted">
                          {s.tip}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {review.subjectIdeas?.length > 0 && (
                <>
                  <div className="label mt-3">New subject ideas</div>
                  <div className="space-y-1">
                    {review.subjectIdeas.map((idea) => (
                      <div
                        key={idea}
                        className="flex items-center justify-between gap-2 rounded-xl bg-subtle px-3 py-1.5 text-sm"
                      >
                        <span className="min-w-0 truncate">{idea}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={Plus}
                          disabled={subjects.includes(idea)}
                          onClick={() => {
                            onApplySubject(idea);
                            toast.ok("Subject line added");
                          }}
                        >
                          {subjects.includes(idea) ? "Added" : "Add"}
                        </Button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {rewrite && (
            <div className="rounded-3xl border border-brand-300 p-4 dark:border-brand-700">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">Suggested version</div>
                <span className="text-xs text-muted">{rewrite.note}</span>
              </div>
              {rewrite.missing?.length > 0 && (
                <p className="mb-2 rounded-xl bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
                  Missing from the new version: {rewrite.missing.join(", ")} —
                  add them back if you need them.
                </p>
              )}
              <div className="rounded-2xl border border-line bg-white p-3">
                <EmailFrame html={rewrite.html} />
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setRewrite(null)}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    onApplyHtml(rewrite.html);
                    setRewrite(null);
                    toast.ok("Email updated — you can still edit it");
                  }}
                >
                  Use this version
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Shown when saving a pitch that scores below 60. */
export function LowScoreModal({ result, onFix, onSaveAnyway, onClose, busy }) {
  if (!result) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title="This pitch may get few replies"
      footer={
        <>
          <Button variant="secondary" onClick={onSaveAnyway} loading={busy}>
            Save anyway
          </Button>
          <Button variant="brand" icon={Lightbulb} onClick={onFix}>
            Show me how to fix it
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-4">
        <ScoreRing score={result.score} size={64} stroke={6} />
        <div>
          <div className="font-semibold" style={{ color: result.grade.hex }}>
            {result.grade.label} ({result.score}/100)
          </div>
          <p className="text-sm text-muted">
            A few quick changes usually raise it above 70:
          </p>
        </div>
      </div>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
        {result.tips.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ol>
    </Modal>
  );
}
