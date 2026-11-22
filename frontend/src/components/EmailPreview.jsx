import { useEffect, useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { post } from "../api/client.js";
import { Segmented, cx } from "./ui.jsx";

/**
 * Inbox-style preview with sample recipient data. HTML is sanitized and personalised server-side
 * and rendered in a sandboxed iframe.
 */
export default function EmailPreview({
  subject,
  html,
  vars,
  height = 288,
  from,
  showFooterNote = true,
}) {
  const [view, setView] = useState("desktop");
  const [preview, setPreview] = useState(null);
  const varsKey = JSON.stringify(vars || {});
  useEffect(() => {
    if (!html) {
      setPreview(null);
      return undefined;
    }
    const t = setTimeout(() => {
      post("/api/pitches/preview", {
        subject: subject || "",
        html,
        vars: vars || undefined,
      })
        .then(setPreview)
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [subject, html, varsKey]);
  const doc = preview?.html
    ? `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:20px 22px;background:#fff;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1f2937;word-wrap:break-word}a{color:#2563eb}</style></head><body>${preview.html}</body></html>`
    : "";
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="label mb-0">Preview</span>
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          options={[
            [
              "desktop",
              <span key="d" className="inline-flex items-center gap-1">
                <Monitor className="h-3.5 w-3.5" />
                Desktop
              </span>,
            ],
            [
              "mobile",
              <span key="m" className="inline-flex items-center gap-1">
                <Smartphone className="h-3.5 w-3.5" />
                Mobile
              </span>,
            ],
          ]}
        />
      </div>
      <div className="rounded-2xl border border-line bg-subtle p-3">
        <div
          className={cx(
            "mx-auto overflow-hidden bg-white text-slate-900 shadow-sm transition-all",
            view === "mobile"
              ? "max-w-[375px] rounded-[28px] ring-8 ring-slate-800/90"
              : "max-w-[680px] rounded-2xl",
          )}
        >
          <div className="border-b border-slate-200 px-5 pt-4 pb-3">
            <div className="text-[15px] leading-snug font-semibold text-slate-900">
              {preview?.subject || subject || (
                <span className="text-slate-400">(no subject)</span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">
                {(from?.name || "Y")[0].toUpperCase()}
              </span>
              <span>
                <b className="text-slate-700">{from?.name || "You"}</b>
                {from?.email && <> &lt;{from.email}&gt;</>}
                <br />
                to{" "}
                {vars
                  ? [vars.firstName, vars.lastName].filter(Boolean).join(" ") ||
                    vars.email ||
                    "recipient"
                  : "Jane Doe"}
              </span>
            </div>
          </div>
          {doc ? (
            <iframe
              title="Email preview"
              sandbox=""
              className="email-preview block w-full"
              style={{ height }}
              srcDoc={doc}
            />
          ) : (
            <div
              className="flex items-center justify-center text-sm text-slate-400"
              style={{ height }}
            >
              Write something to see the preview
            </div>
          )}
          {showFooterNote && doc && (
            <div className="border-t border-dashed border-slate-200 px-5 py-2 text-center text-[11px] text-slate-400">
              Unsubscribe footer is added automatically when sending
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
