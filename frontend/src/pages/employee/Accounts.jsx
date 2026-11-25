import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { del, get, patch, post } from "../../api/client.js";
import { STALE, invalidate } from "../../lib/query.js";
import { Eye, FolderPlus, Pencil, Tag } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  ErrorBox,
  Field,
  Loading,
  Meter,
  Modal,
  PageHeader,
  StatusBadge,
  Table,
  Toggle,
  cx,
  fmt,
  toast,
} from "../../components/ui.jsx";

const GROUP_DEFAULTS = {
  GMAIL: "Gmail",
  GOOGLE_WORKSPACE: "Google Workspace",
  ZOHO: "Zoho",
  YAHOO: "Yahoo",
  REDIFFMAIL: "Rediffmail",
  AMAZON_SES: "Amazon SES",
  CUSTOM: "Custom SMTP",
};

const PROVIDERS = [
  ["GMAIL", "Gmail"],
  ["GOOGLE_WORKSPACE", "Google Workspace"],
  ["ZOHO", "Zoho Mail"],
  ["YAHOO", "Yahoo Mail"],
  ["REDIFFMAIL", "Rediffmail"],
  ["AMAZON_SES", "Amazon SES"],
  ["CUSTOM", "Custom SMTP"],
];

function AccountForm({
  open,
  onClose,
  existing,
  providers,
  googleOAuth,
  groups = [],
}) {
  const editing = Boolean(existing);
  const [f, setF] = useState({});
  const [error, setError] = useState(null);
  const [tests, setTests] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTests(null);
    if (existing) {
      const ses = existing.authType === "SES_API";
      setF({
        ...existing,
        smtpPass: "",
        imapPass: "",
        imapHost: existing.imapHost || "",
        sendMethod: ses ? "SES_API" : "SMTP",
        sesRegion: ses
          ? /^email\.([a-z0-9-]+)\.amazonaws\.com$/.exec(
              existing.smtpHost,
            )?.[1] || ""
          : "",
      });
    } else {
      const p = providers?.GMAIL || {};
      setF({
        provider: "GMAIL",
        email: "",
        displayName: "",
        smtpUser: "",
        smtpPass: "",
        imapUser: "",
        imapPass: "",
        ...p,
        separateImap: false,
        sendMethod: "SES_API",
        sesRegion: "us-east-1",
      });
    }
  }, [open, existing, providers]);

  const set = (k) => (e) =>
    setF((s) => ({
      ...s,
      [k]: e?.target
        ? e.target.type === "checkbox"
          ? e.target.checked
          : e.target.value
        : e,
    }));
  const pickProvider = (e) => {
    const p = providers?.[e.target.value] || {};
    setF((s) => ({
      ...s,
      provider: e.target.value,
      smtpHost: p.smtpHost ?? s.smtpHost,
      smtpPort: p.smtpPort ?? s.smtpPort,
      smtpSecure: p.smtpSecure ?? s.smtpSecure,
      imapHost: p.imapHost ?? "",
      imapPort: p.imapPort ?? 993,
    }));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing && f.sendMethod === "SES_API") {
        const r = await patch(`/api/smtp-accounts/${existing.id}`, {
          displayName: f.displayName || null,
          groupName: f.groupName || null,
          sesRegion: f.sesRegion,
          smtpUser: f.smtpUser,
          ...(f.smtpPass ? { smtpPass: f.smtpPass } : {}),
          imapHost: f.imapHost || null,
          imapPort: f.imapPort ? Number(f.imapPort) : null,
          imapUser: f.imapHost ? f.imapUser : null,
          ...(f.imapPass ? { imapPass: f.imapPass } : {}),
        });
        setTests(r.tests);
        invalidate("accounts");
        toast.ok("Account updated");
        onClose();
        return;
      }
      if (
        !editing &&
        f.provider === "AMAZON_SES" &&
        f.sendMethod === "SES_API"
      ) {
        const r = await post("/api/smtp-accounts", {
          sendMethod: "SES_API",
          sesRegion: f.sesRegion,
          email: f.email,
          displayName: f.displayName || null,
          groupName: f.groupName || null,
          smtpUser: f.smtpUser,
          smtpPass: f.smtpPass,
          imapHost: f.imapHost || null,
          imapPort: f.imapPort ? Number(f.imapPort) : null,
          imapSecure: true,
          imapUser: f.imapHost ? f.imapUser : null,
          imapPass: f.imapHost ? f.imapPass : null,
        });
        setTests(r.tests);
        invalidate("accounts", "dashboard");
        toast.ok("Amazon SES account connected");
        onClose();
        return;
      }
      const body = {
        displayName: f.displayName || null,
        groupName: f.groupName || null,
        provider: f.provider,
        smtpHost: f.smtpHost,
        smtpPort: Number(f.smtpPort),
        smtpSecure: Boolean(f.smtpSecure),
        smtpUser: f.smtpUser || f.email,
        imapHost: f.imapHost || null,
        imapPort: f.imapPort ? Number(f.imapPort) : null,
        imapSecure: true,
        imapUser: f.separateImap ? f.imapUser : null,
        imapPass: f.separateImap && f.imapPass ? f.imapPass : null,
        dkimSelector: f.dkimSelector || null,
      };
      if (f.smtpPass) body.smtpPass = f.smtpPass;
      const r = editing
        ? await patch(`/api/smtp-accounts/${existing.id}`, body)
        : await post("/api/smtp-accounts", { ...body, email: f.email });
      setTests(r.tests);
      invalidate("accounts", "dashboard");
      toast.ok(editing ? "Account updated" : "Account connected");
      if (!r.tests || r.tests.imap?.ok || r.tests.imap?.skipped) onClose();
    } catch (err) {
      setError(err);
      if (err.details?.tests) setTests(err.details.tests);
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    try {
      const r = await get(
        `/api/oauth/google/start?provider=${f.provider}&displayName=${encodeURIComponent(f.displayName || "")}`,
      );
      window.location.href = r.url;
    } catch (err) {
      setError(err);
    }
  };

  const isGoogle = f.provider === "GMAIL" || f.provider === "GOOGLE_WORKSPACE";
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={
        editing
          ? `Reconnect / edit ${existing.email}`
          : "Connect an email account"
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            {editing ? "Save & test" : "Test & connect"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Provider">
          <select
            className="input"
            value={f.provider || ""}
            onChange={pickProvider}
            disabled={editing}
          >
            {PROVIDERS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Email address">
          <input
            className="input"
            type="email"
            value={f.email || ""}
            onChange={set("email")}
            disabled={editing}
            placeholder="you@company.com"
          />
        </Field>
        {providers?.[f.provider]?.note && (
          <p className="md:col-span-2 rounded-2xl bg-subtle px-3 py-2 text-xs text-fg2">
            {providers[f.provider].note}
          </p>
        )}
        {isGoogle && googleOAuth && !editing && (
          <div className="md:col-span-2 flex items-center justify-between rounded-2xl border bg-brand-500/10 px-3 py-2">
            <span className="text-sm text-brand-800 dark:text-brand-200">
              Recommended: connect with Google sign-in (OAuth 2.0) — no password
              stored.
            </span>
            <Button variant="brand" size="sm" onClick={google}>
              Sign in with Google
            </Button>
          </div>
        )}
        {f.provider === "AMAZON_SES" && !editing && (
          <div className="md:col-span-2 flex gap-2">
            <Button
              size="sm"
              variant={f.sendMethod === "SES_API" ? "primary" : "secondary"}
              onClick={() => setF((s) => ({ ...s, sendMethod: "SES_API" }))}
            >
              SES API (HTTPS) — recommended
            </Button>
            <Button
              size="sm"
              variant={f.sendMethod === "SMTP" ? "primary" : "secondary"}
              onClick={() => setF((s) => ({ ...s, sendMethod: "SMTP" }))}
            >
              SES SMTP
            </Button>
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <Field
            label="Sender name"
            hint="Shown as the “From” name and used for {{senderName}} in your signature. Empty = the email address."
          >
            <input
              className="input"
              value={f.displayName || ""}
              onChange={set("displayName")}
              placeholder="Jane from Acme"
            />
          </Field>
          <Field
            label="Group"
            hint="Put similar mailboxes together (e.g. Gmail, Zoho team) to select them all at once in a campaign."
          >
            <input
              className="input"
              list="account-groups"
              value={f.groupName ?? ""}
              onChange={set("groupName")}
              placeholder={GROUP_DEFAULTS[f.provider] || "e.g. Gmail team"}
            />
            <datalist id="account-groups">
              {[...new Set([...groups, ...Object.values(GROUP_DEFAULTS)])].map(
                (g) => (
                  <option key={g} value={g} />
                ),
              )}
            </datalist>
          </Field>
        </div>
        {f.provider === "AMAZON_SES" && f.sendMethod === "SES_API" ? (
          <>
            <Field
              label="AWS region"
              hint="Where your SES identity is verified, e.g. us-east-1, ap-south-1"
            >
              <input
                className="input"
                value={f.sesRegion || ""}
                onChange={set("sesRegion")}
              />
            </Field>
            <Field
              label="IAM access key ID"
              hint="Needs ses:SendRawEmail / ses:SendEmail and ses:GetAccount"
            >
              <input
                className="input"
                value={f.smtpUser || ""}
                onChange={set("smtpUser")}
              />
            </Field>
            <Field
              label={
                editing
                  ? "IAM secret access key (leave blank to keep)"
                  : "IAM secret access key"
              }
            >
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={f.smtpPass || ""}
                onChange={set("smtpPass")}
              />
            </Field>
            <Field
              label="Reply mailbox IMAP host (optional)"
              hint="SES only sends; replies need a separate mailbox"
            >
              <input
                className="input"
                value={f.imapHost || ""}
                onChange={set("imapHost")}
              />
            </Field>
            {f.imapHost && (
              <>
                <Field label="IMAP username">
                  <input
                    className="input"
                    value={f.imapUser || ""}
                    onChange={set("imapUser")}
                  />
                </Field>
                <Field label="IMAP password">
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={f.imapPass || ""}
                    onChange={set("imapPass")}
                  />
                </Field>
              </>
            )}
          </>
        ) : (
          <>
            <Field label="SMTP username" hint="Usually the full email address">
              <input
                className="input"
                value={f.smtpUser || ""}
                onChange={set("smtpUser")}
                placeholder={f.email}
              />
            </Field>
            <Field
              label={
                editing
                  ? "SMTP password / app password (leave blank to keep)"
                  : "SMTP password / app password"
              }
            >
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                value={f.smtpPass || ""}
                onChange={set("smtpPass")}
              />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="SMTP host">
                <input
                  className="input"
                  value={f.smtpHost || ""}
                  onChange={set("smtpHost")}
                />
              </Field>
              <Field label="Port">
                <input
                  className="input"
                  type="number"
                  value={f.smtpPort || ""}
                  onChange={set("smtpPort")}
                />
              </Field>
              <Field label="TLS">
                <select
                  className="input"
                  value={f.smtpSecure ? "ssl" : "starttls"}
                  onChange={(e) =>
                    setF((s) => ({
                      ...s,
                      smtpSecure: e.target.value === "ssl",
                    }))
                  }
                >
                  <option value="ssl">SSL/TLS</option>
                  <option value="starttls">STARTTLS</option>
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-2 md:col-span-2">
              <Field
                label="IMAP host (for replies)"
                hint={
                  f.provider === "AMAZON_SES"
                    ? "SES cannot receive mail — use a separate inbox"
                    : "Leave empty to disable reply detection"
                }
              >
                <input
                  className="input"
                  value={f.imapHost || ""}
                  onChange={set("imapHost")}
                />
              </Field>
              <Field label="IMAP port">
                <input
                  className="input"
                  type="number"
                  value={f.imapPort || ""}
                  onChange={set("imapPort")}
                />
              </Field>
              <Field
                label="DKIM selector (optional)"
                hint="e.g. google, zoho, s1"
              >
                <input
                  className="input"
                  value={f.dkimSelector || ""}
                  onChange={set("dkimSelector")}
                />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Toggle
                checked={f.separateImap}
                onChange={(v) => setF((s) => ({ ...s, separateImap: v }))}
                label="IMAP uses different credentials"
              />
            </div>
            {f.separateImap && (
              <>
                <Field label="IMAP username">
                  <input
                    className="input"
                    value={f.imapUser || ""}
                    onChange={set("imapUser")}
                  />
                </Field>
                <Field label="IMAP password">
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={f.imapPass || ""}
                    onChange={set("imapPass")}
                  />
                </Field>
              </>
            )}
          </>
        )}
      </div>
      {tests && (
        <div className="mt-4 grid gap-2 rounded-2xl bg-subtle p-3 text-sm md:grid-cols-4">
          <div>
            Sending{tests.smtp?.via ? ` (${tests.smtp.via})` : ""}:{" "}
            {tests.smtp?.ok ? (
              <Badge color="green">ok</Badge>
            ) : (
              <Badge color="red">failed</Badge>
            )}
          </div>
          <div>
            IMAP:{" "}
            {tests.imap?.skipped ? (
              <Badge>not set</Badge>
            ) : tests.imap?.ok ? (
              <Badge color="green">ok</Badge>
            ) : (
              <Badge color="red" title={tests.imap?.error}>
                failed
              </Badge>
            )}
          </div>
          <div>
            SPF:{" "}
            {tests.dns?.spf ? (
              <Badge color="green">found</Badge>
            ) : (
              <Badge color="yellow">missing</Badge>
            )}
          </div>
          <div>
            DMARC:{" "}
            {tests.dns?.dmarc ? (
              <Badge color="green">found</Badge>
            ) : (
              <Badge color="yellow">missing</Badge>
            )}
          </div>
          {tests.imap?.error && (
            <div className="text-xs text-red-600 dark:text-red-400 md:col-span-4">
              {tests.imap.error}
            </div>
          )}
        </div>
      )}
      <div className="mt-3">
        <ErrorBox error={error} />
      </div>
      <p className="mt-3 text-xs text-muted">
        Credentials are encrypted (AES-256-GCM) before storage and are never
        shown again.
      </p>
    </Modal>
  );
}

function TestEmail({ account, onClose }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await post(`/api/smtp-accounts/${account.id}/test-email`, { to });
      toast.ok(`Test email sent to ${to}`);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={Boolean(account)}
      onClose={onClose}
      title={`Send a test email from ${account?.email}`}
      footer={
        <Button onClick={send} loading={busy} disabled={!to}>
          Send test
        </Button>
      }
    >
      <Field label="Send to">
        <input
          className="input"
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="you@example.com"
        />
      </Field>
    </Modal>
  );
}

function EditDetails({ account, groups, onClose }) {
  const [f, setF] = useState({ displayName: "", groupName: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (account) {
      setF({
        displayName: account.displayName || "",
        groupName: account.groupName || "",
      });
      setError(null);
    }
  }, [account]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/smtp-accounts/${account.id}`, {
        displayName: f.displayName.trim() || null,
        groupName: f.groupName.trim() || null,
      });
      invalidate("accounts");
      toast.ok("Saved");
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={Boolean(account)}
      onClose={onClose}
      title={`Edit ${account?.email || ""}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label="Sender name"
          hint="Shown as the “From” name and used for {{senderName}}. Empty = the email address."
        >
          <input
            className="input"
            value={f.displayName}
            onChange={(e) => setF({ ...f, displayName: e.target.value })}
            placeholder="Jane from Acme"
          />
        </Field>
        <Field label="Group">
          <input
            className="input"
            list="account-groups-edit"
            value={f.groupName}
            onChange={(e) => setF({ ...f, groupName: e.target.value })}
            placeholder="e.g. Gmail team"
          />
          <datalist id="account-groups-edit">
            {[...new Set([...groups, ...Object.values(GROUP_DEFAULTS)])].map(
              (g) => (
                <option key={g} value={g} />
              ),
            )}
          </datalist>
        </Field>
        <p className="text-xs text-muted">
          To change the password, server or Google sign-in use <b>Reconnect</b>.
        </p>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-3 border-b border-line py-2 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words text-fg">{children ?? "—"}</span>
    </div>
  );
}

function ViewAccount({ account, onClose }) {
  const a = account;
  return (
    <Modal open={Boolean(a)} onClose={onClose} wide title={a?.email || ""}>
      {a && (
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="label">Account</div>
            <Row label="Sender name">
              {a.displayName || (
                <span className="text-muted">— (email address is used)</span>
              )}
            </Row>
            <Row label="Group">{a.groupName}</Row>
            <Row label="Provider">
              {PROVIDERS.find(([v]) => v === a.provider)?.[1]}
            </Row>
            <Row label="Sends via">
              {a.transport === "GMAIL_API"
                ? "Gmail API (Google sign-in)"
                : a.transport === "SES_API"
                  ? "Amazon SES API"
                  : `SMTP ${a.smtpHost}:${a.smtpPort} (${a.smtpSecure ? "SSL/TLS" : "STARTTLS"})`}
            </Row>
            <Row label="Status">
              <StatusBadge status={a.status} />{" "}
              {a.adminDisabled && <Badge color="red">disabled by admin</Badge>}
            </Row>
            <Row label="Connected since">{fmt.date(a.createdAt)}</Row>
            <Row label="Last test">{fmt.date(a.lastTestAt)}</Row>
            {a.lastError && (
              <Row label="Last error">
                <span className="text-red-600 dark:text-red-400">
                  {a.lastError}
                </span>
              </Row>
            )}
          </div>
          <div>
            <div className="label">Replies (IMAP)</div>
            <Row label="Server">
              {a.imapHost
                ? `${a.imapHost}:${a.imapPort || 993}`
                : "Not set — replies and bounces are not detected"}
            </Row>
            <Row label="Status">
              {a.imapHost ? (
                a.imapOk ? (
                  <Badge color="green">connected</Badge>
                ) : (
                  <Badge color="red">error</Badge>
                )
              ) : (
                "—"
              )}
            </Row>
            <Row label="Folders checked">
              {a.imapHost
                ? `Inbox${a.imapSpamPath ? ` + ${a.imapSpamPath}` : " (+ Spam once found)"}`
                : "—"}
            </Row>
            <Row label="Last checked">
              {a.imapLastSyncAt ? fmt.rel(a.imapLastSyncAt) : "not yet"}
            </Row>
            <div className="label mt-5">Sending</div>
            <Row label="Today">
              {a.usage.day} of {a.limits.daily}
            </Row>
            <Row label="This hour">
              {a.usage.hour} of {a.limits.hourly}
            </Row>
            <Row label="Warm-up">
              {a.limits.warmup
                ? `Day ${a.limits.warmup.day} of ${a.limits.warmup.totalDays} — ${a.limits.warmup.percent}% of the normal ${a.limits.fullDaily}/day`
                : "Off / finished — full limits"}
            </Row>
            <Row label="Bounce rate (7 days)">
              {(a.bounceRate * 100).toFixed(1)}%
            </Row>
            <Row label="SPF / DMARC">
              {a.dnsSpf ? "SPF ✓" : "SPF ✗"} ·{" "}
              {a.dnsDmarc ? "DMARC ✓" : "DMARC ✗"}
            </Row>
          </div>
        </div>
      )}
    </Modal>
  );
}

function GroupModal({ ids, groups, onClose }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await post("/api/smtp-accounts/group", {
        ids,
        groupName: name.trim() || null,
      });
      invalidate("accounts");
      toast.ok(
        `${r.updated} account(s) ${name.trim() ? `moved to “${name.trim()}”` : "removed from their group"}`,
      );
      onClose(true);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={ids.length > 0}
      onClose={() => onClose(false)}
      title={`Group ${ids.length} account${ids.length === 1 ? "" : "s"}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy}>
            Save group
          </Button>
        </>
      }
    >
      <Field
        label="Group name"
        hint="Leave empty to remove them from their group."
      >
        <input
          autoFocus
          className="input"
          list="account-groups-bulk"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Gmail, Zoho team, Yahoo"
        />
        <datalist id="account-groups-bulk">
          {[...new Set([...groups, ...Object.values(GROUP_DEFAULTS)])].map(
            (g) => (
              <option key={g} value={g} />
            ),
          )}
        </datalist>
      </Field>
      {groups.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setName(g)}
              className="rounded-full border border-line px-2.5 py-1 text-xs text-fg2 hover:border-brand-400"
            >
              {g}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function Accounts() {
  const [params, setParams] = useSearchParams();
  const [form, setForm] = useState({ open: false, existing: null });
  const [testing, setTesting] = useState(null);
  const [testEmail, setTestEmail] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [editing, setEditing] = useState(null);
  const [group, setGroup] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [grouping, setGrouping] = useState([]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => get("/api/smtp-accounts"),
    staleTime: STALE.accounts,
  });
  const { data: prov } = useQuery({
    queryKey: ["providers"],
    queryFn: () => get("/api/smtp-accounts/providers"),
    staleTime: STALE.config,
  });

  useEffect(() => {
    if (params.get("connect") === "1") {
      setForm({ open: true, existing: null });
      setParams({}, { replace: true });
      return;
    }
    const o = params.get("oauth");
    if (o) {
      if (o === "success") {
        toast.ok("Google account connected");
        invalidate("accounts", "dashboard");
      } else
        toast.error({
          message: params.get("message") || "Google sign-in failed",
        });
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const allAccounts = useMemo(() => data?.accounts || [], [data]);
  const groups = useMemo(
    () =>
      [...new Set(allAccounts.map((a) => a.groupName).filter(Boolean))].sort(),
    [allAccounts],
  );
  const accounts = group
    ? allAccounts.filter((a) =>
        group === "__none" ? !a.groupName : a.groupName === group,
      )
    : allAccounts;
  const allChecked =
    accounts.length > 0 && accounts.every((a) => selected.has(a.id));
  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const runTest = async (a) => {
    setTesting(a.id);
    try {
      const r = await post(`/api/smtp-accounts/${a.id}/test`);
      invalidate("accounts");
      if (r.tests.smtp.ok)
        toast.ok(`${a.email}: SMTP ok${r.tests.imap.ok ? ", IMAP ok" : ""}`);
      else toast.error({ message: `${a.email}: ${r.tests.smtp.error}` });
    } catch (err) {
      toast.error(err);
    } finally {
      setTesting(null);
    }
  };
  const reconnectGoogle = async (a) => {
    try {
      const r = await get(
        `/api/oauth/google/start?provider=${a.provider}&displayName=${encodeURIComponent(a.displayName || "")}`,
      );
      window.location.href = r.url;
    } catch (err) {
      toast.error(err);
    }
  };
  const remove = async (a) => {
    try {
      await del(`/api/smtp-accounts/${a.id}`);
      invalidate("accounts", "dashboard");
      toast.ok("Account removed (history kept)");
    } catch (err) {
      toast.error(err);
    }
  };

  if (isLoading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const { slots, permissions, dailyTotal } = data;
  const egress = prov?.smtpEgress;
  const countIn = (g) =>
    allAccounts.filter((a) =>
      g === "__none" ? !a.groupName : a.groupName === g,
    ).length;
  return (
    <>
      <PageHeader
        title="Email accounts"
        subtitle={`${slots.used} of ${slots.limit} account slots used · ${slots.remaining} remaining${dailyTotal ? ` · sent today ${dailyTotal.sent.toLocaleString()} of ${dailyTotal.limit.toLocaleString()} (all accounts together)` : ""}`}
        actions={
          <Button
            variant="brand"
            disabled={!permissions.create || slots.remaining <= 0}
            onClick={() => setForm({ open: true, existing: null })}
          >
            Connect account
          </Button>
        }
      />
      {egress?.status === "restricted" && (
        <div className="mb-4 rounded-2xl border bg-amber-500/12 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          <b>
            This server cannot send over SMTP ports{" "}
            {egress.blockedPorts.join(", ")}.
          </b>{" "}
          Render Free web services block outbound SMTP. Accounts that work here:
          Gmail / Google Workspace via <b>Google sign-in</b> (sends through the
          Gmail API), <b>Amazon SES API</b>, or an SMTP relay that accepts port{" "}
          <b>2525</b>. Zoho, Yahoo and Rediffmail SMTP need the backend on a
          paid Render instance. Receiving replies (IMAP, port 993) works either
          way.
        </div>
      )}
      {allAccounts.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Tag className="h-4 w-4 text-muted" />
          {[
            ["", `All (${allAccounts.length})`],
            ...groups.map((g) => [g, `${g} (${countIn(g)})`]),
            ...(countIn("__none") && groups.length
              ? [["__none", `No group (${countIn("__none")})`]]
              : []),
          ].map(([v, l]) => (
            <button
              key={v || "all"}
              type="button"
              onClick={() => {
                setGroup(v);
                setSelected(new Set());
              }}
              className={cx(
                "rounded-full px-3 py-1.5 text-xs font-medium transition",
                group === v
                  ? "bg-inv text-inv-fg"
                  : "bg-subtle text-fg2 hover:text-fg",
              )}
            >
              {l}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 && (
              <span className="text-xs text-muted">
                {selected.size} selected
              </span>
            )}
            <Button
              size="sm"
              variant="secondary"
              icon={FolderPlus}
              disabled={!selected.size}
              onClick={() => setGrouping([...selected])}
            >
              Set group
            </Button>
          </div>
        </div>
      )}
      <Card padded={false}>
        <Table
          head={[
            <input
              key="all"
              type="checkbox"
              aria-label="Select all"
              checked={allChecked}
              onChange={() =>
                setSelected(
                  allChecked ? new Set() : new Set(accounts.map((a) => a.id)),
                )
              }
            />,
            "Account",
            "Sending / IMAP",
            "Today",
            "Limits",
            "Health",
            "",
          ]}
          empty={
            !accounts.length && (
              <div className="p-8 text-center text-sm text-muted">
                {allAccounts.length
                  ? "No accounts in this group."
                  : "No accounts yet. Connect Gmail, Zoho, Yahoo, Rediffmail, Amazon SES or any SMTP server."}
              </div>
            )
          }
        >
          {accounts.map((a) => (
            <tr key={a.id}>
              <td className="td w-8">
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={() => toggle(a.id)}
                  aria-label={`Select ${a.email}`}
                />
              </td>
              <td className="td">
                <button
                  type="button"
                  className="text-left font-medium hover:text-brand-600 dark:hover:text-brand-300"
                  onClick={() => setViewing(a)}
                >
                  {a.email}
                </button>
                <div className="text-xs text-muted">
                  {a.displayName || <i>no sender name</i>} ·{" "}
                  {a.provider.replace("_", " ").toLowerCase()}
                  {a.authType === "OAUTH2" && " · Google sign-in"}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <StatusBadge status={a.status} />
                  {a.groupName && <Badge color="blue">{a.groupName}</Badge>}
                  {a.adminDisabled && (
                    <Badge color="red">disabled by admin</Badge>
                  )}
                </div>
              </td>
              <td className="td text-xs">
                <div>
                  {a.transport === "GMAIL_API"
                    ? "Gmail API"
                    : a.transport === "SES_API"
                      ? "SES API"
                      : "SMTP"}{" "}
                  {a.smtpOk ? (
                    <Badge color="green">connected</Badge>
                  ) : (
                    <Badge color="red">error</Badge>
                  )}
                </div>
                <div className="mt-1">
                  IMAP{" "}
                  {a.imapHost ? (
                    a.imapOk ? (
                      <Badge color="green">connected</Badge>
                    ) : (
                      <Badge color="red">error</Badge>
                    )
                  ) : (
                    <Badge>not set</Badge>
                  )}
                </div>
                {a.imapLastSyncAt && (
                  <div className="mt-1 text-faint">
                    checked {fmt.rel(a.imapLastSyncAt)}
                  </div>
                )}
              </td>
              <td className="td w-44">
                <Meter label="Daily" value={a.usage.day} max={a.limits.daily} />
                <div className="mt-1 text-xs text-muted">
                  {a.usage.hour} this hour
                </div>
              </td>
              <td className="td text-xs">
                <div>
                  {a.limits.hourly}/hour · {a.limits.daily}/day
                </div>
                {a.limits.warmup && (
                  <Badge
                    color="blue"
                    title={`${a.limits.warmup.percent}% of the normal limit`}
                  >
                    warm-up day {a.limits.warmup.day}/
                    {a.limits.warmup.totalDays}
                  </Badge>
                )}
              </td>
              <td className="td text-xs">
                <div>Bounce {(a.bounceRate * 100).toFixed(1)}%</div>
                <div>
                  SPF {a.dnsSpf ? "✓" : "✗"} · DMARC {a.dnsDmarc ? "✓" : "✗"}
                </div>
                {a.lastError && (
                  <div className="mt-1 max-w-xs text-red-600 dark:text-red-400">
                    {a.lastError}
                  </div>
                )}
              </td>
              <td className="td">
                <div className="flex flex-wrap justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Eye}
                    onClick={() => setViewing(a)}
                  >
                    View
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Pencil}
                    disabled={!permissions.edit}
                    onClick={() => setEditing(a)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={testing === a.id}
                    onClick={() => runTest(a)}
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={a.status !== "CONNECTED"}
                    onClick={() => setTestEmail(a)}
                  >
                    Test email
                  </Button>
                  {a.authType === "OAUTH2" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!permissions.reconnect || !prov?.googleOAuth}
                      onClick={() => reconnectGoogle(a)}
                    >
                      Reconnect
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!permissions.edit}
                      onClick={() => setForm({ open: true, existing: a })}
                    >
                      Reconnect
                    </Button>
                  )}
                  {permissions.delete && (
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      confirm="Delete account?"
                      onConfirm={() => remove(a)}
                    >
                      Delete
                    </ConfirmButton>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <AccountForm
        open={form.open}
        existing={form.existing}
        providers={prov?.providers}
        googleOAuth={prov?.googleOAuth}
        groups={groups}
        onClose={() => setForm({ open: false, existing: null })}
      />
      <TestEmail account={testEmail} onClose={() => setTestEmail(null)} />
      <ViewAccount account={viewing} onClose={() => setViewing(null)} />
      <EditDetails
        account={editing}
        groups={groups}
        onClose={() => setEditing(null)}
      />
      <GroupModal
        ids={grouping}
        groups={groups}
        onClose={(done) => {
          setGrouping([]);
          if (done) setSelected(new Set());
        }}
      />
    </>
  );
}
