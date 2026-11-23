import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "../../api/client.js";
import { STALE, invalidate } from "../../lib/query.js";
import {
  Button,
  Card,
  ErrorBox,
  Field,
  Loading,
  PageHeader,
  Segmented,
  Toggle,
} from "../../components/ui.jsx";
import ContactsInput, {
  uploadContacts,
} from "../../components/ContactsInput.jsx";
import AccountPicker from "../../components/AccountPicker.jsx";
import EmailPreview from "../../components/EmailPreview.jsx";
import RichEditor, { VariableMenu } from "../../components/RichEditor.jsx";
import { ScoreChip, ScorePanel } from "../../components/PitchScore.jsx";
import { scorePitch } from "../../lib/pitchScore.js";

export default function CampaignNew() {
  const navigate = useNavigate();
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => get("/api/smtp-accounts"),
    staleTime: STALE.accounts,
  });
  const lists = useQuery({
    queryKey: ["lists"],
    queryFn: () => get("/api/lists"),
    staleTime: STALE.lists,
  });
  const pitches = useQuery({
    queryKey: ["pitches"],
    queryFn: () => get("/api/pitches"),
    staleTime: STALE.lists,
  });
  const [f, setF] = useState({
    name: "",
    accountIds: [],
    hourlyRate: 30,
    listIds: [],
    mode: "pitch",
    pitchVersionId: "",
    subject: "",
    html: "",
    text: "",
    rotate: false,
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [recMode, setRecMode] = useState("paste");
  const [pasted, setPasted] = useState([]);
  const [pasteList, setPasteList] = useState({ name: "", id: null, count: 0 });
  const [step, setStep] = useState("");
  const [bodyInit, setBodyInit] = useState({ html: "", key: 0 });
  const [scoreOpen, setScoreOpen] = useState(false);

  const usable = (accounts.data?.accounts || []).filter(
    (a) => a.status === "CONNECTED" && !a.adminDisabled,
  );
  const chosen = usable.filter((a) => f.accountIds.includes(a.id));
  const account = chosen[0];
  // Speed options of the chosen account with the highest limit; each account is clamped to its own limit when sending.
  const speedFrom = chosen.reduce(
    (best, a) => (!best || a.limits.hourly > best.limits.hourly ? a : best),
    null,
  );
  const pitch = (pitches.data?.pitches || []).find(
    (p) => p.latest?.id === f.pitchVersionId,
  );
  const listCount = useMemo(
    () =>
      (lists.data?.lists || [])
        .filter((l) => f.listIds.includes(l.id))
        .reduce((s, l) => s + l.contacts, 0),
    [lists.data, f.listIds],
  );
  const recipientsCount = listCount + pasted.length;
  useEffect(() => {
    if (lists.data && !lists.data.lists.length) setRecMode("paste");
  }, [lists.data]);
  const sampleVars = pasted[0]
    ? {
        firstName: pasted[0].firstName || "",
        lastName: pasted[0].lastName || "",
        companyName: pasted[0].company || "",
        company: pasted[0].company || "",
        email: pasted[0].email,
        ...(pasted[0].fields || {}),
      }
    : undefined;
  const customScore = useMemo(
    () => scorePitch({ subjects: [f.subject], html: f.html }),
    [f.subject, f.html],
  );
  const defaultListName = `${f.name.trim() || "Campaign"} — pasted ${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;

  useEffect(() => {
    if (!f.accountIds.length && usable[0] && !f.touchedAccounts)
      setF((s) => ({
        ...s,
        accountIds: [usable[0].id],
        hourlyRate: Math.min(s.hourlyRate, usable[0].limits.hourly),
      }));
  }, [usable, f.accountIds.length, f.touchedAccounts]);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const toggleList = (id) =>
    setF((s) => ({
      ...s,
      listIds: s.listIds.includes(id)
        ? s.listIds.filter((x) => x !== id)
        : [...s.listIds, id],
    }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const listIds = [...f.listIds];
      if (pasted.length) {
        // Pasted contacts are saved as a list (so they can be reused and audited), then included in the campaign.
        let id = pasteList.id;
        if (!id || pasteList.count !== pasted.length) {
          setStep("Saving pasted contacts…");
          const r = await post("/api/lists", {
            name: (pasteList.name.trim() || defaultListName).slice(0, 150),
            source: "Pasted while creating a campaign",
          });
          id = r.list.id;
          await uploadContacts(id, pasted, {
            consentSource: "Pasted while creating a campaign",
            onProgress: (d, t) => setStep(`Saving pasted contacts… ${d}/${t}`),
          });
          setPasteList((p) => ({ ...p, id, count: pasted.length }));
          invalidate("lists");
        }
        listIds.push(id);
      }
      if (!listIds.length)
        throw new Error(
          "Add recipients: paste email addresses or choose a saved list",
        );
      setStep("Creating campaign…");
      if (!f.accountIds.length)
        throw new Error("Choose at least one sending account");
      const body = {
        name: f.name,
        accountIds: f.accountIds,
        hourlyRate: Number(f.hourlyRate),
        listIds,
      };
      if (f.mode === "pitch")
        Object.assign(body, {
          pitchVersionId: f.pitchVersionId,
          subject: f.subject || undefined,
          rotateSubjects: Boolean(
            f.rotate && pitch?.latest.subjects.length > 1,
          ),
        });
      else
        Object.assign(body, {
          subject: f.subject,
          html: f.html,
          text: f.text || undefined,
        });
      const r = await post("/api/campaigns", body);
      invalidate("campaigns", "dashboard");
      navigate(`/app/campaigns/${r.campaign.id}?created=1`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  if (accounts.isLoading || lists.isLoading) return <Loading />;
  if (!usable.length) {
    return (
      <Card>
        <p className="text-sm">
          Connect an email account first.{" "}
          <Link
            className="text-brand-600 dark:text-brand-300"
            to="/app/accounts"
          >
            Go to email accounts →
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title="Create campaign"
        subtitle="Creates a draft. You can review, send a test and then start or schedule it."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="1 · Basics">
            <div className="space-y-3">
              <Field label="Campaign name">
                <input
                  className="input"
                  value={f.name}
                  onChange={set("name")}
                  placeholder="Q4 outreach — manufacturing"
                />
              </Field>
              <div>
                <span className="label">Send from</span>
                <AccountPicker
                  accounts={usable}
                  value={f.accountIds}
                  recipients={recipientsCount}
                  ratePerAccount={Number(f.hourlyRate)}
                  onChange={(ids) =>
                    setF((s) => ({
                      ...s,
                      accountIds: ids,
                      touchedAccounts: true,
                    }))
                  }
                />
              </div>
              <Field
                label={
                  f.accountIds.length > 1
                    ? "Sending speed (per account)"
                    : "Sending speed"
                }
                hint="Each account never goes above its own hourly and daily limit, even when other campaigns use it too."
              >
                <select
                  className="input"
                  value={f.hourlyRate}
                  onChange={set("hourlyRate")}
                >
                  {(speedFrom?.speedOptions || []).map((o) => (
                    <option key={o.perHour} value={o.perHour}>
                      {o.perHour} emails/hour — one every{" "}
                      {o.everySeconds >= 60
                        ? `${Math.round(o.everySeconds / 60)} min`
                        : `${o.everySeconds}s`}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </Card>
          <Card
            title="2 · Recipients"
            actions={
              <Link
                to="/app/lists"
                className="text-xs text-brand-600 dark:text-brand-300"
              >
                Manage lists
              </Link>
            }
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Segmented
                size="sm"
                value={recMode}
                onChange={setRecMode}
                options={[
                  [
                    "paste",
                    `Paste emails${pasted.length ? ` (${pasted.length})` : ""}`,
                  ],
                  [
                    "lists",
                    `Saved lists${f.listIds.length ? ` (${f.listIds.length})` : ""}`,
                  ],
                ]}
              />
              <span className="text-xs font-medium text-fg2">
                {recipientsCount} recipient{recipientsCount === 1 ? "" : "s"}
              </span>
            </div>
            {recMode === "paste" ? (
              <div className="space-y-3">
                <ContactsInput compact onChange={setPasted} />
                {pasted.length > 0 && (
                  <Field
                    label="Save these contacts as a list"
                    hint="Reuse it later from Saved lists or the Recipients page."
                  >
                    <input
                      className="input"
                      value={pasteList.name}
                      placeholder={defaultListName}
                      onChange={(e) =>
                        setPasteList((p) => ({
                          ...p,
                          name: e.target.value,
                          id: null,
                        }))
                      }
                    />
                  </Field>
                )}
              </div>
            ) : (lists.data?.lists || []).length === 0 ? (
              <p className="text-sm text-muted">
                No saved lists yet — use{" "}
                <button
                  type="button"
                  className="font-medium text-brand-600 dark:text-brand-300"
                  onClick={() => setRecMode("paste")}
                >
                  Paste emails
                </button>
                .
              </p>
            ) : (
              <div className="space-y-1">
                {lists.data.lists.map((l) => (
                  <label
                    key={l.id}
                    className="flex items-center justify-between rounded-2xl px-2 py-1.5 hover:bg-subtle"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={f.listIds.includes(l.id)}
                        onChange={() => toggleList(l.id)}
                      />{" "}
                      {l.name}
                    </span>
                    <span className="text-xs text-muted">
                      {l.contacts} contacts
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="pt-3 text-xs text-muted">
              You can combine pasted emails and saved lists. Duplicates and
              unsubscribed, bounced or complained addresses are removed
              automatically.
            </p>
          </Card>
          <Card title="3 · Content">
            <div className="mb-3 flex gap-2">
              <Button
                size="sm"
                variant={f.mode === "pitch" ? "primary" : "secondary"}
                onClick={() => setF((s) => ({ ...s, mode: "pitch" }))}
              >
                Use a pitch
              </Button>
              <Button
                size="sm"
                variant={f.mode === "custom" ? "primary" : "secondary"}
                onClick={() => setF((s) => ({ ...s, mode: "custom" }))}
              >
                Write content
              </Button>
            </div>
            {f.mode === "pitch" ? (
              <div className="space-y-3">
                <Field label="Pitch">
                  <select
                    className="input"
                    value={f.pitchVersionId}
                    onChange={(e) => {
                      const p = pitches.data.pitches.find(
                        (x) => x.latest.id === e.target.value,
                      );
                      setF((s) => ({
                        ...s,
                        pitchVersionId: e.target.value,
                        subject: p?.latest.subjects[0] || "",
                      }));
                    }}
                  >
                    <option value="">Choose a pitch…</option>
                    {(pitches.data?.pitches || []).map((p) => (
                      <option key={p.id} value={p.latest.id}>
                        {p.name} (v{p.latest.version})
                      </option>
                    ))}
                  </select>
                </Field>
                {pitch && pitch.latest.subjects.length > 1 && (
                  <div className="rounded-2xl border border-line p-3">
                    <Toggle
                      checked={f.rotate}
                      onChange={(v) => setF((s) => ({ ...s, rotate: v }))}
                      label={`Rotate all ${pitch.latest.subjects.length} subject lines`}
                      description="Recipients get the subject lines in turn (1, 2, 3, 1, 2, 3…). Follow-ups keep each person's own subject."
                    />
                  </div>
                )}
                {pitch && !f.rotate && (
                  <Field label="Subject line">
                    <select
                      className="input"
                      value={f.subject}
                      onChange={set("subject")}
                    >
                      {pitch.latest.subjects.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {pitch && f.rotate && (
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-fg2">
                    {pitch.latest.subjects.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <span className="label">Subject</span>
                  <div className="flex items-center gap-1 rounded-2xl border border-line bg-card py-1 pr-1 pl-3 focus-within:border-brand-400 focus-within:ring-4 focus-within:ring-brand-500/10">
                    <input
                      className="h-9 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
                      placeholder="e.g. Quick question, {{firstName}}"
                      value={f.subject}
                      onChange={set("subject")}
                      maxLength={250}
                    />
                    <VariableMenu
                      compact
                      align="right"
                      onInsert={(v) =>
                        setF((s) => ({ ...s, subject: s.subject + v }))
                      }
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <ScoreChip
                    result={customScore}
                    onClick={() => setScoreOpen(true)}
                  />
                  <span className="min-w-0 flex-1 text-xs text-muted">
                    {customScore.tips[0] || "Looks good — send a test first."}
                  </span>
                </div>
                <ScorePanel
                  open={scoreOpen}
                  onClose={() => setScoreOpen(false)}
                  result={customScore}
                  subjects={[f.subject]}
                  html={f.html}
                  onApplySubject={(t) => setF((s) => ({ ...s, subject: t }))}
                  onApplyHtml={(h) =>
                    setBodyInit((b) => ({ html: h, key: b.key + 1 }))
                  }
                />
                <div>
                  <span className="label">Email body</span>
                  <RichEditor
                    resetKey={`campaign-new-${bodyInit.key}`}
                    initialHtml={bodyInit.html}
                    minHeight={240}
                    onChange={(h) => setF((s) => ({ ...s, html: h }))}
                    placeholder="Hi {{firstName}}, … (paste or type, then press Format)"
                  />
                </div>
                <Field
                  label="Plain-text version (optional)"
                  hint="Created from the email body if left empty"
                >
                  <textarea
                    className="input h-24 font-mono text-xs"
                    value={f.text}
                    onChange={set("text")}
                  />
                </Field>
              </div>
            )}
          </Card>
          <ErrorBox error={error} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {step && <span className="mr-auto text-xs text-muted">{step}</span>}
            {!step && !busy && (!f.name || !recipientsCount) && (
              <span className="mr-auto text-xs text-muted">
                {!f.name ? "Add a campaign name" : "Add recipients"} to continue
              </span>
            )}
            <Link to="/app/campaigns">
              <Button variant="secondary">Cancel</Button>
            </Link>
            <Button
              variant="brand"
              onClick={submit}
              loading={busy}
              disabled={
                !f.name ||
                !recipientsCount ||
                !f.accountIds.length ||
                (f.mode === "pitch" ? !f.pitchVersionId : !f.subject || !f.html)
              }
            >
              Create draft
            </Button>
          </div>
        </div>
        <Card title="Preview">
          <EmailPreview
            subject={
              f.mode === "pitch" && f.rotate
                ? pitch?.latest.subjects[0]
                : f.subject
            }
            html={f.mode === "pitch" ? pitch?.latest.html : f.html}
            height={420}
            vars={sampleVars}
            from={
              account
                ? {
                    name: account.displayName || account.email,
                    email: account.email,
                  }
                : undefined
            }
          />
          {pasted[0] && (
            <p className="mt-2 text-xs text-muted">
              Previewing as <b className="text-fg2">{pasted[0].email}</b> — the
              first pasted recipient.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
