import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { del, get, post, put } from "../../api/client.js";
import { STALE, invalidate } from "../../lib/query.js";
import {
  Button,
  Card,
  ConfirmButton,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  Segmented,
  StatusBadge,
  Table,
  cx,
  fmt,
  toast,
} from "../../components/ui.jsx";
import EmailPreview from "../../components/EmailPreview.jsx";
import RichEditor from "../../components/RichEditor.jsx";
import SubjectList from "../../components/SubjectList.jsx";
import { useAuth } from "../../store/auth.js";
import { Eye, LayoutTemplate, Pencil, Trash2 } from "lucide-react";
import {
  LowScoreModal,
  ScoreChip,
  ScorePanel,
} from "../../components/PitchScore.jsx";
import { scorePitch } from "../../lib/pitchScore.js";
import { PITCH_TEMPLATES } from "../../lib/pitchTemplates.js";

const SAMPLE = `<p>Hi {{firstName|there}},</p>
<p>I noticed that {{companyName}} is growing, and I wanted to introduce our services.</p>
<p>We help businesses like yours to:</p>
<ul><li><p>Save time on repetitive work</p></li><li><p>Reach more customers</p></li></ul>
<p>Would you be open to a quick 10-minute call this week?</p>
<p>Regards,<br>{{senderName}}</p>`;

function Editor({ open, onClose, pitch }) {
  const user = useAuth((s) => s.user);
  const [name, setName] = useState("");
  const [subjects, setSubjects] = useState([""]);
  const [activeSubject, setActiveSubject] = useState(0);
  const [html, setHtml] = useState("");
  const [text, setText] = useState("");
  const [showText, setShowText] = useState(false);
  const [view, setView] = useState("split");
  const [sample, setSample] = useState({
    firstName: "Jane",
    lastName: "Doe",
    companyName: "Example Co",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [resetKey, setResetKey] = useState(0);
  const [initial, setInitial] = useState("");
  const [scoreOpen, setScoreOpen] = useState(false);
  const [lowScore, setLowScore] = useState(false);
  const result = useMemo(
    () => scorePitch({ subjects, html }),
    [subjects, html],
  );
  const replaceBody = (h) => {
    setInitial(h);
    setResetKey((k) => k + 1);
  };
  const applyTemplate = (id) => {
    const t = PITCH_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setSubjects([...t.subjects]);
    setActiveSubject(0);
    if (!name.trim()) setName(t.name);
    replaceBody(t.html);
    toast.ok("Template loaded — replace the [brackets] with your own words");
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(pitch?.name || "");
    setSubjects(
      pitch
        ? [...pitch.latest.subjects]
        : ["Quick question for {{companyName|your team}}"],
    );
    setActiveSubject(0);
    setText(pitch?.latest.text || "");
    setShowText(false);
    setInitial(pitch ? pitch.latest.html : SAMPLE);
    setResetKey((k) => k + 1);
    setView(window.innerWidth < 1024 ? "write" : "split");
  }, [open, pitch]);

  const cleanSubjects = subjects.map((x) => x.trim()).filter(Boolean);
  const save = async (force = false) => {
    if (!name.trim()) {
      setError(new Error("Give the pitch a name"));
      return;
    }
    if (!cleanSubjects.length) {
      setError(new Error("Add at least one subject line"));
      return;
    }
    if (!html.replace(/<[^>]+>|&nbsp;/g, "").trim()) {
      setError(new Error("Write the email body"));
      return;
    }
    if (/\[[^\]]{3,}\]/.test(html.replace(/<[^>]+>/g, ""))) {
      setError(
        new Error(
          "Replace the [text in brackets] from the template with your own words",
        ),
      );
      return;
    }
    if (!force && result.score < 60) {
      setLowScore(true);
      return;
    }
    setLowScore(false);
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        subjects: cleanSubjects,
        html,
        text: text.trim() || undefined,
      };
      if (pitch) await put(`/api/pitches/${pitch.id}`, body);
      else await post("/api/pitches", body);
      invalidate("pitches");
      toast.ok(pitch ? "Saved as a new version" : "Pitch created");
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const previewSubject = subjects[activeSubject] ?? subjects[0] ?? "";
  const preview = (
    <div className="space-y-3">
      {cleanSubjects.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">Previewing subject</span>
          {subjects.map(
            (sub, i) =>
              sub.trim() && (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveSubject(i)}
                  className={cx(
                    "rounded-full px-2.5 py-1 text-xs font-medium transition",
                    activeSubject === i
                      ? "bg-inv text-inv-fg"
                      : "bg-subtle text-fg2 hover:text-fg",
                  )}
                >
                  {i + 1}
                </button>
              ),
          )}
        </div>
      )}
      <EmailPreview
        subject={previewSubject}
        html={html}
        vars={sample}
        height={view === "preview" ? 520 : 400}
        from={{ name: user?.name, email: user?.email }}
      />
      <details className="rounded-2xl border border-line px-3 py-2 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-fg2">
          Sample recipient
        </summary>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {[
            ["firstName", "First name"],
            ["lastName", "Last name"],
            ["companyName", "Company"],
          ].map(([k, l]) => (
            <Field key={k} label={l}>
              <input
                className="input h-9 text-sm"
                value={sample[k]}
                onChange={(e) => setSample({ ...sample, [k]: e.target.value })}
              />
            </Field>
          ))}
        </div>
      </details>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={pitch ? `Edit “${pitch.name}”` : "New pitch"}
      headerExtra={
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          options={[
            ["write", "Write"],
            [
              "split",
              <span key="s" className="hidden lg:inline">
                Side by side
              </span>,
            ],
            ["preview", "Preview"],
          ].filter(([v]) => v !== "split" || window.innerWidth >= 1024)}
        />
      }
      footer={
        <>
          {pitch && (
            <span className="mr-auto self-center text-xs text-muted">
              Saving creates version {pitch.latest.version + 1}. Campaigns
              already using v{pitch.latest.version} keep their content.
            </span>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" onClick={() => save(false)} loading={busy}>
            {pitch ? "Save new version" : "Save pitch"}
          </Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-subtle/70 px-3 py-2">
        <ScoreChip result={result} onClick={() => setScoreOpen(true)} />
        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted sm:block">
          {result.tips[0]
            ? `Tip: ${result.tips[0]}`
            : "Looks good — send yourself a test before using it."}
        </span>
        {!pitch && (
          <label className="flex items-center gap-2 text-xs text-fg2">
            <LayoutTemplate className="h-4 w-4 text-muted" />
            <select
              className="input h-9 w-auto py-0 text-xs"
              value=""
              onChange={(e) => applyTemplate(e.target.value)}
              aria-label="Start from a template"
            >
              <option value="">Start from a template…</option>
              {PITCH_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div
        className={cx(
          "grid gap-6",
          view === "split" && "lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]",
        )}
      >
        <div className={cx("space-y-4", view === "preview" && "hidden")}>
          <Field label="Pitch name">
            <input
              className="input"
              placeholder="e.g. Intro – IT services"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div>
            <span className="label">Subject lines</span>
            <SubjectList
              value={subjects}
              onChange={setSubjects}
              active={activeSubject}
              onActive={setActiveSubject}
            />
            <p className="mt-1.5 text-xs text-muted">
              Add several to choose from — or rotate them across recipients —
              when you create a campaign.
            </p>
          </div>
          <div>
            <span className="label">Email body</span>
            <RichEditor
              initialHtml={initial}
              resetKey={resetKey}
              onChange={setHtml}
              placeholder="Hi {{firstName}}, … (paste or type, then press Format)"
            />
          </div>
          <div>
            <button
              type="button"
              onClick={() => setShowText((v) => !v)}
              className="text-xs font-medium text-fg2 hover:text-fg"
            >
              {showText ? "▾" : "▸"} Plain-text version{" "}
              <span className="text-muted">
                (optional — created automatically)
              </span>
            </button>
            {showText && (
              <textarea
                className="input mt-2 h-28 font-mono text-xs"
                placeholder="Leave empty to generate it from the email body"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </div>
          <ErrorBox error={error} />
        </div>
        {view !== "write" && (
          <div
            className={cx(
              view === "split" && "lg:sticky lg:top-0 lg:self-start",
            )}
          >
            {preview}
          </div>
        )}
        {view === "preview" && <ErrorBox error={error} />}
      </div>
      <ScorePanel
        open={scoreOpen}
        onClose={() => setScoreOpen(false)}
        result={result}
        subjects={subjects}
        html={html}
        onApplySubject={(t) =>
          setSubjects((s) =>
            s.includes(t) ? s : [...s.filter((x) => x.trim()), t].slice(0, 10),
          )
        }
        onApplyHtml={replaceBody}
      />
      {lowScore && (
        <LowScoreModal
          result={result}
          busy={busy}
          onClose={() => setLowScore(false)}
          onSaveAnyway={() => save(true)}
          onFix={() => {
            setLowScore(false);
            setScoreOpen(true);
          }}
        />
      )}
    </Modal>
  );
}

function ViewPitch({ pitch, onClose }) {
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [pitch]);
  if (!pitch) return null;
  const subjects = pitch.latest.subjects;
  return (
    <Modal open onClose={onClose} size="xl" title={pitch.name}>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted">
          v{pitch.latest.version} · {subjects.length} subject line
          {subjects.length === 1 ? "" : "s"}:
        </span>
        {subjects.map((sub, k) => (
          <button
            key={sub}
            type="button"
            onClick={() => setI(k)}
            className={cx(
              "max-w-xs truncate rounded-full px-2.5 py-1 text-xs",
              i === k
                ? "bg-inv text-inv-fg"
                : "bg-subtle text-fg2 hover:text-fg",
            )}
          >
            {sub}
          </button>
        ))}
      </div>
      <EmailPreview
        subject={subjects[i]}
        html={pitch.latest.html}
        height={460}
      />
    </Modal>
  );
}

function Versions({ id, onClose }) {
  const { data } = useQuery({
    queryKey: ["pitch", id],
    queryFn: () => get(`/api/pitches/${id}`),
    enabled: Boolean(id),
  });
  return (
    <Modal
      open={Boolean(id)}
      onClose={onClose}
      wide
      title={`Versions — ${data?.pitch.name || ""}`}
    >
      {!data ? (
        <Loading />
      ) : (
        <div className="space-y-3">
          {data.pitch.versions.map((v) => (
            <div key={v.id} className="rounded-2xl border border-line p-3">
              <div className="flex justify-between text-sm">
                <b>v{v.version}</b>
                <span className="text-xs text-muted">
                  {fmt.date(v.createdAt)}
                </span>
              </div>
              <div className="text-xs text-fg2">
                Subjects: {v.subjects.join(" · ")}
              </div>
              {v.campaigns.length > 0 && (
                <div className="mt-1 text-xs">
                  Used in:{" "}
                  {v.campaigns.map((c) => (
                    <span key={c.id} className="mr-2">
                      {c.name} <StatusBadge status={c.status} />
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export default function Pitches() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["pitches"],
    queryFn: () => get("/api/pitches"),
    staleTime: STALE.lists,
  });
  const [editing, setEditing] = useState({ open: false, pitch: null });
  const [versions, setVersions] = useState(null);
  const [viewing, setViewing] = useState(null);
  const responses = useQuery({
    queryKey: ["responses", 90],
    queryFn: () => get("/api/reports/responses?days=90"),
    staleTime: 60_000,
  });
  const perf = useMemo(() => {
    const m = new Map();
    for (const r of responses.data?.pitches || []) {
      const e = m.get(r.id) || { sent: 0, replied: 0, interested: 0 };
      e.sent += r.sent;
      e.replied += r.replied;
      e.interested += r.interested;
      m.set(r.id, e);
    }
    return m;
  }, [responses.data]);
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get("new") === "1") {
      setEditing({ open: true, pitch: null });
      setParams({}, { replace: true });
    }
  }, [params, setParams]);
  const dup = async (p) => {
    try {
      await post(`/api/pitches/${p.id}/duplicate`);
      invalidate("pitches");
      toast.ok("Duplicated");
    } catch (err) {
      toast.error(err);
    }
  };
  const remove = async (p) => {
    try {
      const r = await del(`/api/pitches/${p.id}`);
      invalidate("pitches");
      toast.ok(r.deleted ? "Pitch deleted" : r.message);
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <>
      <PageHeader
        title="Pitches"
        subtitle="Reusable email templates with versions and personalisation"
        actions={
          <Button
            variant="brand"
            onClick={() => setEditing({ open: true, pitch: null })}
          >
            New pitch
          </Button>
        }
      />
      {error && !data && <ErrorBox error={error} />}
      {isLoading && !data ? (
        <Loading />
      ) : (
        <Card padded={false}>
          <Table
            head={[
              "Pitch",
              "Subjects",
              "Reply rate (90 days)",
              "Version",
              "Used in",
              "Updated",
              "",
            ]}
            empty={
              !data?.pitches.length && (
                <div className="p-8 text-center text-sm text-muted">
                  No pitches yet.
                </div>
              )
            }
          >
            {(data?.pitches || []).map((p) => (
              <tr key={p.id}>
                <td className="td font-medium">
                  <button
                    type="button"
                    className="text-left hover:text-brand-600 dark:hover:text-brand-300"
                    onClick={() => setViewing(p)}
                  >
                    {p.name}
                  </button>
                </td>
                <td className="td max-w-xs text-xs text-fg2">
                  {p.latest.subjects.join(" · ")}
                </td>
                <td className="td text-sm">
                  {perf.get(p.id)?.sent ? (
                    <span
                      title={`${perf.get(p.id).replied} replies · ${perf.get(p.id).interested} interested · ${perf.get(p.id).sent} sent`}
                    >
                      <b className="tabular-nums">
                        {(
                          (perf.get(p.id).replied / perf.get(p.id).sent) *
                          100
                        ).toFixed(1)}
                        %
                      </b>
                      <span className="block text-xs text-muted">
                        {perf.get(p.id).replied} of {perf.get(p.id).sent}
                        {perf.get(p.id).interested
                          ? ` · ${perf.get(p.id).interested} interested`
                          : ""}
                      </span>
                    </span>
                  ) : (
                    <span className="text-xs text-muted">not sent yet</span>
                  )}
                </td>
                <td className="td">v{p.latest.version}</td>
                <td className="td">{p.campaignsUsing} campaign(s)</td>
                <td className="td text-xs">{fmt.date(p.updatedAt)}</td>
                <td className="td">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Eye}
                      onClick={() => setViewing(p)}
                    >
                      View
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={Pencil}
                      onClick={() => setEditing({ open: true, pitch: p })}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setVersions(p.id)}
                    >
                      Versions
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => dup(p)}>
                      Duplicate
                    </Button>
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      confirm="Delete pitch?"
                      onConfirm={() => remove(p)}
                    >
                      <Trash2 className="mr-1 inline h-3.5 w-3.5" />
                      Delete
                    </ConfirmButton>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <Editor
        open={editing.open}
        pitch={editing.pitch}
        onClose={() => setEditing({ open: false, pitch: null })}
      />
      <Versions id={versions} onClose={() => setVersions(null)} />
      <ViewPitch pitch={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
