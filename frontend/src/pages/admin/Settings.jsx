import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AtSign,
  Bot,
  CheckCircle2,
  Gauge,
  KeyRound,
  Lock,
  MailX,
  Palette,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Unplug,
  XCircle,
} from "lucide-react";
import { del, get, post, put } from "../../api/client.js";
import { STALE, invalidate } from "../../lib/query.js";
import {
  Badge,
  Button,
  ErrorBox,
  Field,
  Loading,
  Notice,
  PageHeader,
  Toggle,
  cx,
  toast,
} from "../../components/ui.jsx";
import {
  AppearancePanel,
  PanelTitle,
  SecurityPanel,
  SettingsShell,
} from "../../components/SettingsKit.jsx";

const TABS = [
  {
    id: "limits",
    label: "Account limits",
    desc: "Mailboxes per employee",
    icon: AtSign,
  },
  {
    id: "sending",
    label: "Sending & warm-up",
    desc: "Daily, hourly, retries, health",
    icon: Gauge,
  },
  {
    id: "permissions",
    label: "Permissions & tracking",
    desc: "What employees can change",
    icon: SlidersHorizontal,
  },
  {
    id: "security",
    label: "Login security",
    desc: "Email OTP and reset codes",
    icon: ShieldCheck,
  },
  {
    id: "ai",
    label: "AI assistant",
    desc: "Google Gemini, free-tier limits",
    icon: Bot,
  },
  {
    id: "footer",
    label: "Unsubscribe footer",
    desc: "Compliance footer styling",
    icon: MailX,
  },
  {
    id: "appearance",
    label: "Appearance",
    desc: "Theme and motion",
    icon: Palette,
  },
  {
    id: "account",
    label: "My password",
    desc: "Password and devices",
    icon: Lock,
  },
];

const NUMS = {
  limits: [
    [
      "defaultAccountLimit",
      "Default email accounts per employee",
      "Used when an employee has no individual limit",
    ],
    [
      "maxAccountLimit",
      "Maximum accounts any employee may have",
      "Individual limits can never exceed this",
    ],
  ],
  sending: [
    ["defaultDailyLimit", "Default emails/day per employee"],
    ["maxEmployeeDailyLimit", "Maximum emails/day for any employee"],
    ["defaultHourlyLimit", "Default max emails/hour per account"],
    ["maxWorkingCampaigns", "Working campaigns per employee"],
    ["maxRetries", "Retries for temporary failures"],
    [
      "warmupStartPercent",
      "Warm-up: day 1 volume (% of normal limit)",
      "Default 20 — new accounts send 20% of their limit on day 1",
    ],
    [
      "warmupDays",
      "Warm-up length (days)",
      "Default 10 — full limit is reached on this day",
    ],
    [
      "bounceRatePauseThreshold",
      "Auto-pause at bounce rate",
      "0.08 = 8% over 7 days (min. 20 sends)",
    ],
    [
      "complaintRatePauseThreshold",
      "Complaint-rate threshold",
      "Where providers report complaints",
    ],
    ["imapSyncIntervalMin", "Reply sync interval (minutes)"],
    ["healthCheckIntervalSec", "Health check interval (seconds)"],
  ],
};
const AI_NUMS = [
  [
    "aiPerMinute",
    "AI requests per minute (whole team)",
    "Free tier allows about 10 — keep 8 for safety",
  ],
  [
    "aiDailyLimit",
    "AI requests per day (whole team)",
    "Free tier allows about 250 for Flash models — keep 200. Resets at midnight Pacific (≈1:30 pm India).",
  ],
  [
    "aiUserDailyLimit",
    "AI requests per employee per day",
    "Stops one person using everyone’s allowance",
  ],
];
const AI_TOGGLES = [
  [
    "aiEnabled",
    "AI assistant",
    "Pitch review, subject-line ideas and rewrites with Google Gemini. Only pitch text with {{placeholders}} is sent.",
  ],
  [
    "aiReplyAssist",
    "AI reply drafts in the Inbox",
    "Sends the text of a received reply to Gemini to draft an answer. Switch off if client messages must not leave your systems.",
  ],
];

function AiPanel({ ai, f, setF, saveBtn }) {
  return (
    <>
      <PanelTitle
        title="AI assistant"
        subtitle="Uses Google Gemini. Limits below keep usage inside Gemini’s free tier."
      />
      {!ai?.configured ? (
        <Notice tone="warn" className="mb-5">
          <b>No Gemini key yet.</b> Add <code>GEMINI_API_KEY=…</code> to{" "}
          <code>backend/.env</code> (locally) or to the backend’s Environment on
          Render, then restart. Get a free key at aistudio.google.com → Get API
          key. Optional: <code>GEMINI_MODEL</code> (default
          gemini-flash-latest).
        </Notice>
      ) : (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-subtle p-4">
            <div className="text-xs text-muted">Status</div>
            <div className="mt-1 font-semibold">
              {ai.enabled ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  On
                </span>
              ) : (
                "Off"
              )}
            </div>
            <div className="text-xs text-muted">{ai.model}</div>
          </div>
          <div className="rounded-2xl bg-subtle p-4">
            <div className="text-xs text-muted">Used today (team)</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {ai.usedToday}
              <span className="text-sm text-muted"> / {ai.dailyLimit}</span>
            </div>
          </div>
          <div className="rounded-2xl bg-subtle p-4">
            <div className="text-xs text-muted">Resets</div>
            <div className="mt-1 font-semibold">
              {new Date(ai.resetsAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
            <div className="text-xs text-muted">midnight Pacific time</div>
          </div>
        </div>
      )}
      <div className="space-y-4">
        {AI_TOGGLES.map(([k, label, d], i) => (
          <div key={k}>
            {i > 0 && <div className="mb-4 h-px bg-line" />}
            <Toggle
              checked={f[k]}
              onChange={(v) => setF({ ...f, [k]: v })}
              label={label}
              description={d}
            />
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-5 sm:grid-cols-3">
        {AI_NUMS.map(([k, label, hint]) => (
          <Field key={k} label={label} hint={hint}>
            <input
              className="input"
              type="number"
              min="1"
              value={f[k]}
              onChange={(e) => setF({ ...f, [k]: e.target.value })}
            />
          </Field>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">
        Identical requests are answered from a 6-hour cache and don’t count
        again. If Google still reports its limit, the assistant pauses for about
        a minute. On Gemini’s free tier Google may use requests to improve its
        products — use a paid key if that’s not acceptable.
      </p>
      <div className="mt-6 flex justify-end border-t border-line pt-5">
        {saveBtn}
      </div>
    </>
  );
}

const TOGGLES = [
  ["allowAccountCreate", "Employees can add accounts"],
  ["allowAccountEdit", "Employees can edit accounts"],
  ["allowAccountDelete", "Employees can remove accounts"],
  ["allowAccountReconnect", "Employees can reconnect removed accounts"],
  [
    "trackingEnabled",
    "Open & click tracking",
    "Adds a tracking pixel and signed click redirects. Results are approximate.",
  ],
];

function LoginSecurity({ settings, mail }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(null);
  const save = async (patch) => {
    setBusy("toggle");
    try {
      await put("/api/admin/settings", patch);
      invalidate(["admin", "settings"]);
      toast.ok("Login security updated");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  const connect = async () => {
    setBusy("connect");
    try {
      const r = await get("/api/admin/system-mail/google/start");
      window.location.href = r.url;
    } catch (err) {
      toast.error(err);
      setBusy(null);
    }
  };
  const disconnect = async () => {
    setBusy("disconnect");
    try {
      await del("/api/admin/system-mail/google");
      invalidate(["admin", "settings"]);
      toast.ok("Google mailbox disconnected");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    try {
      const r = await post("/api/admin/system-mail/test", { to });
      toast.ok(
        `Test email sent via ${r.via === "GMAIL_API" ? "Gmail API" : "SMTP"}`,
      );
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <PanelTitle
        title="Login security"
        subtitle="Require a 6-digit code, emailed to the user's own address, after the password."
      />
      <div className="space-y-5">
        <div className="rounded-3xl bg-subtle p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span
                className={cx(
                  "flex h-11 w-11 items-center justify-center rounded-2xl",
                  mail.configured
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
                )}
              >
                {mail.configured ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <XCircle className="h-5 w-5" />
                )}
              </span>
              <div>
                <div className="font-medium">
                  OTP mailbox{" "}
                  {mail.configured ? (
                    <Badge color="green">Ready</Badge>
                  ) : (
                    <Badge color="yellow">Not configured</Badge>
                  )}
                </div>
                <div className="mt-0.5 text-sm text-muted">
                  {mail.from || "emailspro.otp@gmail.com"}
                  {mail.via &&
                    ` · ${mail.via === "GMAIL_API" ? "Gmail API (Google sign-in)" : "SMTP app password"}`}
                </div>
                <div className="mt-1 max-w-xl text-xs text-muted">
                  {mail.note}
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {settings.systemMailConnected ? (
                <Button
                  variant="outline"
                  size="sm"
                  icon={Unplug}
                  loading={busy === "disconnect"}
                  onClick={disconnect}
                >
                  Disconnect Google
                </Button>
              ) : (
                <Button
                  size="sm"
                  icon={KeyRound}
                  loading={busy === "connect"}
                  onClick={connect}
                >
                  Connect with Google
                </Button>
              )}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <Field label="Send a test code email to">
              <input
                className="input w-72"
                type="email"
                placeholder="you@company.com"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Button
              variant="secondary"
              icon={Send}
              disabled={!to || !mail.configured}
              loading={busy === "test"}
              onClick={test}
            >
              Send test
            </Button>
          </div>
        </div>

        <div className="space-y-4 rounded-3xl border border-line p-5">
          <Toggle
            label="Email OTP for employees"
            description="Employees enter a 6-digit code sent to their account email after their password. Codes expire after 10 minutes, allow 5 attempts and can be resent after 45 seconds."
            checked={settings.otpLoginEnabled}
            disabled={
              busy === "toggle" ||
              (!mail.configured && !settings.otpLoginEnabled)
            }
            onChange={(v) => save({ otpLoginEnabled: v })}
          />
          <div className="h-px bg-line" />
          <Toggle
            label="Also require OTP for administrators"
            description="Make sure the OTP mailbox works first — admins can't sign in without the code."
            checked={settings.otpForAdmins}
            disabled={
              busy === "toggle" || (!mail.configured && !settings.otpForAdmins)
            }
            onChange={(v) => save({ otpForAdmins: v })}
          />
        </div>
        {!mail.configured && (
          <Notice tone="warn">
            Connect the OTP mailbox before enabling codes, otherwise nobody
            could sign in. The same mailbox sends “forgot password” codes.
          </Notice>
        )}
        <Notice tone="neutral">
          <b>Which method should I use?</b> Render Free blocks SMTP ports, so on
          Render use <b>Connect with Google</b> (requires GOOGLE_CLIENT_ID /
          GOOGLE_CLIENT_SECRET) to send through the Gmail API. For local or paid
          hosting you can instead set <code>SYSTEM_MAIL_APP_PASSWORD</code> (a
          Gmail app password for emailspro.otp@gmail.com) in{" "}
          <code>backend/.env</code>.
        </Notice>
      </div>
    </>
  );
}

export default function AdminSettings() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get("tab") || "limits");
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "settings"],
    queryFn: () => get("/api/admin/settings"),
    staleTime: STALE.config,
  });
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  useEffect(() => {
    if (data) setF(data.settings);
  }, [data]);
  useEffect(() => {
    const m = params.get("mailer");
    if (m) {
      if (m === "connected") {
        toast.ok("OTP mailbox connected with Google");
        invalidate(["admin", "settings"]);
      } else
        toast.error({
          message: params.get("message") || "Google sign-in failed",
        });
      setParams({ tab: "security" }, { replace: true });
    }
  }, [params, setParams]);

  if (isLoading || !f) return error ? <ErrorBox error={error} /> : <Loading />;
  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      const body = {};
      [...NUMS.limits, ...NUMS.sending].forEach(([k]) => {
        body[k] = Number(f[k]);
      });
      TOGGLES.forEach(([k]) => {
        body[k] = Boolean(f[k]);
      });
      AI_TOGGLES.forEach(([k]) => {
        body[k] = Boolean(f[k]);
      });
      AI_NUMS.forEach(([k]) => {
        body[k] = Number(f[k]);
      });
      body.footerHtml = f.footerHtml;
      body.footerText = f.footerText;
      await put("/api/admin/settings", body);
      invalidate("admin");
      toast.ok("Settings saved");
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  };
  const saveBtn = (
    <Button loading={busy} onClick={save}>
      Save changes
    </Button>
  );
  const numGrid = (rows) => (
    <div className="grid gap-5 sm:grid-cols-2">
      {rows.map(([k, label, hint]) => (
        <Field key={k} label={label} hint={hint}>
          <input
            className="input"
            type="number"
            step="any"
            value={f[k]}
            onChange={(e) => setF({ ...f, [k]: e.target.value })}
          />
        </Field>
      ))}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Policies & settings"
        subtitle="System-wide defaults. Per-employee and per-account overrides can only be lower than these maximums."
      />
      <SettingsShell
        tabs={TABS}
        active={tab}
        onChange={(t) => {
          setTab(t);
          setParams(t === "limits" ? {} : { tab: t }, { replace: true });
        }}
      >
        {tab === "limits" && (
          <>
            <PanelTitle
              title="Account limits"
              subtitle="How many email accounts each employee may connect."
            />
            {numGrid(NUMS.limits)}
            <div className="mt-6 flex justify-end border-t border-line pt-5">
              {saveBtn}
            </div>
          </>
        )}
        {tab === "sending" && (
          <>
            <PanelTitle
              title="Sending & warm-up"
              subtitle="The lowest applicable limit always wins: system → employee → account → warm-up → health → campaign speed."
            />
            {numGrid(NUMS.sending)}
            <div className="mt-6 flex justify-end border-t border-line pt-5">
              {saveBtn}
            </div>
          </>
        )}
        {tab === "permissions" && (
          <>
            <PanelTitle
              title="Permissions & tracking"
              subtitle="What employees can do with their email accounts."
            />
            <div className="space-y-4">
              {TOGGLES.map(([k, label, d], i) => (
                <div key={k}>
                  {i > 0 && <div className="mb-4 h-px bg-line" />}
                  <Toggle
                    checked={f[k]}
                    onChange={(v) => setF({ ...f, [k]: v })}
                    label={label}
                    description={d}
                  />
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-end border-t border-line pt-5">
              {saveBtn}
            </div>
          </>
        )}
        {tab === "security" && (
          <LoginSecurity settings={data.settings} mail={data.systemMail} />
        )}
        {tab === "footer" && (
          <>
            <PanelTitle
              title="Unsubscribe footer"
              subtitle="Restyle it freely, but it must keep {{unsubscribeUrl}}. RFC 8058 one-click headers are always added (Gmail & Yahoo bulk-sender rules)."
            />
            <div className="grid gap-5 xl:grid-cols-2">
              <Field label="HTML footer">
                <textarea
                  className="input h-40 font-mono text-xs"
                  value={f.footerHtml}
                  onChange={(e) => setF({ ...f, footerHtml: e.target.value })}
                />
              </Field>
              <Field label="Plain-text footer">
                <textarea
                  className="input h-40 font-mono text-xs"
                  value={f.footerText}
                  onChange={(e) => setF({ ...f, footerText: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-4 rounded-2xl bg-white p-4 text-slate-800 ring-1 ring-line">
              <div className="mb-1 text-xs text-slate-400">Preview</div>
              <iframe
                title="footer"
                sandbox=""
                className="h-16 w-full"
                srcDoc={f.footerHtml.replaceAll("{{unsubscribeUrl}}", "#")}
              />
            </div>
            <div className="mt-6 flex justify-end border-t border-line pt-5">
              {saveBtn}
            </div>
          </>
        )}
        {tab === "ai" && (
          <AiPanel ai={data.ai} f={f} setF={setF} saveBtn={saveBtn} />
        )}
        {tab === "appearance" && <AppearancePanel />}
        {tab === "account" && <SecurityPanel />}
        {saveError && (
          <div className="mt-4">
            <ErrorBox error={saveError} />
          </div>
        )}
      </SettingsShell>
    </>
  );
}
