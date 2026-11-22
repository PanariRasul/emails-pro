import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  Download,
  FileSpreadsheet,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { Segmented, Toggle, cx } from "./ui.jsx";
import { parseFile, parsePasted, toApiRows } from "../lib/contacts.js";
import { post } from "../api/client.js";

const EMPTY = { contacts: [], invalid: [], duplicates: 0 };

/** Upload parsed contacts to a list in batches of 1,000. Returns totals from the server. */
export async function uploadContacts(
  listId,
  contacts,
  { consentSource, onProgress } = {},
) {
  const rows = toApiRows(contacts);
  const totals = { added: 0, duplicates: 0, invalid: 0, suppressed: 0 };
  for (let i = 0; i < rows.length; i += 1000) {
    const r = await post(`/api/lists/${listId}/contacts`, {
      contacts: rows.slice(i, i + 1000),
      consentSource: consentSource || undefined,
    });
    Object.keys(totals).forEach((k) => {
      totals[k] += r[k] || 0;
    });
    onProgress?.(Math.min(rows.length, i + 1000), rows.length);
  }
  return totals;
}

const SAMPLES = [
  ["/samples/emails-pro-contacts-sample.xlsx", "Sample Excel"],
  ["/samples/emails-pro-contacts-sample.csv", "Sample CSV"],
];

export function SampleLinks({ className }) {
  return (
    <div className={cx("flex flex-wrap items-center gap-2", className)}>
      <span className="text-xs text-muted">Collect data in this format:</span>
      {SAMPLES.map(([href, label]) => (
        <a
          key={href}
          href={href}
          download
          className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs font-medium text-fg2 transition hover:border-brand-400 hover:text-brand-600 dark:hover:text-brand-300"
        >
          <Download className="h-3.5 w-3.5" />
          {label}
        </a>
      ))}
    </div>
  );
}

const PLACEHOLDER = `Paste email addresses — one per line, or separated by commas:

ravi.kumar@acme-tools.com
meera@novaplastics.in, john@example.com
Priya Sharma <priya@brightsteel.co.in>

You can also paste rows straight from Excel or Google Sheets.`;

/**
 * Paste or upload contacts. Calls onChange(contacts) with parsed rows
 * ({ email, firstName, lastName, company, fields, guessed }).
 */
export default function ContactsInput({ onChange, compact = false }) {
  const [tab, setTab] = useState("paste");
  const [text, setText] = useState("");
  const [guess, setGuess] = useState(true);
  const [file, setFile] = useState(null);
  const [fileResult, setFileResult] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [edits, setEdits] = useState({});
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const deferredText = useDeferredValue(text);
  const pasted = useMemo(
    () => parsePasted(deferredText, { guess }),
    [deferredText, guess],
  );
  useEffect(() => {
    // re-read the file when the guess switch changes
    if (!file) return;
    parseFile(file, { guess })
      .then((r) => {
        setFileResult(r);
        setFileError(null);
      })
      .catch((e) => {
        setFileResult(null);
        setFileError(e);
      });
  }, [file, guess]);

  const base = tab === "paste" ? pasted : fileResult || EMPTY;
  const contacts = useMemo(
    () =>
      base.contacts.map((c) =>
        edits[c.email] ? { ...c, ...edits[c.email] } : c,
      ),
    [base, edits],
  );
  useEffect(() => {
    onChangeRef.current?.(contacts);
  }, [contacts]);

  const edit = (email, key, value) =>
    setEdits((e) => ({
      ...e,
      [email]: {
        ...e[email],
        [key]: value,
        guessed: {
          ...(base.contacts.find((c) => c.email === email)?.guessed || {}),
          ...(e[email]?.guessed || {}),
          [key]: false,
        },
      },
    }));
  const pickFile = (f) => {
    if (f) {
      setFile(f);
      setEdits({});
    }
  };
  const guessedCount = contacts.filter(
    (c) => c.guessed?.firstName || c.guessed?.company,
  ).length;
  const withName = contacts.filter((c) => c.firstName).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          size="sm"
          value={tab}
          onChange={(t) => {
            setTab(t);
            setEdits({});
          }}
          options={[
            [
              "paste",
              <span key="p" className="inline-flex items-center gap-1.5">
                <ClipboardPaste className="h-3.5 w-3.5" />
                Paste emails
              </span>,
            ],
            [
              "file",
              <span key="f" className="inline-flex items-center gap-1.5">
                <FileSpreadsheet className="h-3.5 w-3.5" />
                Upload Excel / CSV
              </span>,
            ],
          ]}
        />
        {!compact && <SampleLinks />}
      </div>

      {tab === "paste" ? (
        <div className="relative">
          <textarea
            className="input min-h-40 resize-y py-3 font-mono text-[13px] leading-relaxed"
            placeholder={PLACEHOLDER}
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
          {text && (
            <button
              type="button"
              onClick={() => {
                setText("");
                setEdits({});
              }}
              className="absolute top-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-subtle hover:text-fg"
              aria-label="Clear"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pickFile(e.dataTransfer.files[0]);
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
          className={cx(
            "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition",
            drag
              ? "border-brand-500 bg-brand-500/5"
              : "border-line hover:border-brand-400 hover:bg-subtle/60",
          )}
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <Upload className="h-5 w-5" />
          </span>
          <div className="text-sm font-medium text-fg">
            {file
              ? file.name
              : "Drop your Excel or CSV file here, or click to choose"}
          </div>
          <div className="text-xs text-muted">
            .xlsx or .csv · needs an <b>email</b> column · firstName, lastName,
            company and any other column are optional
          </div>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              pickFile(e.target.files[0]);
              e.target.value = "";
            }}
          />
        </div>
      )}
      {compact && <SampleLinks />}
      {fileError && tab === "file" && (
        <p className="rounded-2xl bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {fileError.message}
        </p>
      )}

      <Toggle
        checked={guess}
        onChange={setGuess}
        label="Fill missing names and companies from the email address"
        description="ravi.kumar@acme-tools.com → Ravi Kumar, Acme Tools. Role addresses like info@ and free mailboxes like Gmail are left blank."
      />

      {(contacts.length > 0 ||
        base.invalid.length > 0 ||
        base.duplicates > 0) && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 font-medium text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {contacts.length} ready
          </span>
          <span className="inline-flex items-center rounded-full bg-subtle px-2.5 py-1 text-fg2">
            {withName} with a first name
          </span>
          {guessedCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-500/10 px-2.5 py-1 text-brand-700 dark:text-brand-300">
              <Sparkles className="h-3.5 w-3.5" />
              {guessedCount} filled from email
            </span>
          )}
          {base.duplicates > 0 && (
            <span className="inline-flex items-center rounded-full bg-subtle px-2.5 py-1 text-fg2">
              {base.duplicates} duplicates removed
            </span>
          )}
          {base.invalid.length > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-amber-700 dark:text-amber-300"
              title={base.invalid.join(", ")}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              {base.invalid.length} invalid skipped:{" "}
              {base.invalid.slice(0, 3).join(", ")}
              {base.invalid.length > 3 ? "…" : ""}
            </span>
          )}
        </div>
      )}

      {contacts.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-line">
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-subtle text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">First name</th>
                  <th className="px-3 py-2 font-medium">Last name</th>
                  <th className="px-3 py-2 font-medium">Company</th>
                  {contacts.some((c) => c.fields) && (
                    <th className="px-3 py-2 font-medium">Other</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {contacts.slice(0, 200).map((c) => (
                  <tr key={c.email}>
                    <td className="max-w-[240px] truncate px-3 py-1.5 text-fg">
                      {c.email}
                    </td>
                    {["firstName", "lastName", "company"].map((k) => (
                      <td key={k} className="px-1.5 py-1">
                        <input
                          value={c[k] || ""}
                          onChange={(e) => edit(c.email, k, e.target.value)}
                          placeholder="—"
                          title={
                            c.guessed?.[k]
                              ? "Filled from the email address — check it"
                              : undefined
                          }
                          className={cx(
                            "h-8 w-full min-w-[90px] rounded-lg border border-transparent bg-transparent px-1.5 text-sm text-fg outline-none placeholder:text-faint hover:border-line focus:border-brand-400",
                            c.guessed?.[k] &&
                              "bg-brand-500/[.07] italic text-brand-700 dark:text-brand-300",
                          )}
                        />
                      </td>
                    ))}
                    {contacts.some((x) => x.fields) && (
                      <td className="px-3 py-1.5 text-xs text-muted">
                        {c.fields
                          ? Object.entries(c.fields)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(" · ")
                          : ""}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-subtle/50 px-3 py-1.5 text-[11px] text-muted">
            <span>
              {contacts.length > 200
                ? `Showing 200 of ${contacts.length}. `
                : ""}
              Click any name or company to correct it.
            </span>
            {guessedCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded bg-brand-500/30" />{" "}
                <i>Italic</i> = filled from email
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
