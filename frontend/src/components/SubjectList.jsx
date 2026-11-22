import { useRef } from "react";
import { Plus, X } from "lucide-react";
import { cx } from "./ui.jsx";
import { VariableMenu } from "./RichEditor.jsx";

export const MAX_SUBJECTS = 10;

/** Editable list of subject lines (1–10), each with variable insert and a length hint. */
export default function SubjectList({ value, onChange, active, onActive }) {
  const refs = useRef([]);
  const set = (i, v) => onChange(value.map((s, j) => (j === i ? v : s)));
  const add = () => {
    if (value.length < MAX_SUBJECTS) {
      onChange([...value, ""]);
      setTimeout(() => refs.current[value.length]?.focus(), 0);
    }
  };
  const remove = (i) => {
    onChange(value.filter((_, j) => j !== i));
    if (active >= value.length - 1) onActive?.(Math.max(0, value.length - 2));
  };
  const insert = (i, v) => {
    const el = refs.current[i];
    const s = value[i] || "";
    const at = el?.selectionStart ?? s.length;
    const end = el?.selectionEnd ?? s.length;
    set(i, s.slice(0, at) + v + s.slice(end));
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(at + v.length, at + v.length);
    }, 0);
  };
  return (
    <div className="space-y-2">
      {value.map((s, i) => {
        const len = s.trim().length;
        return (
          <div
            key={i}
            className={cx(
              "group flex items-center gap-2 rounded-2xl border bg-card py-1 pr-1 pl-3 transition focus-within:border-brand-400 focus-within:ring-4 focus-within:ring-brand-500/10",
              active === i
                ? "border-brand-300 dark:border-brand-700"
                : "border-line",
            )}
          >
            <span className="w-5 shrink-0 text-xs font-semibold text-muted">
              {i + 1}
            </span>
            <input
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint"
              placeholder={
                i === 0
                  ? "e.g. Quick question, {{firstName}}"
                  : "Another subject line"
              }
              value={s}
              maxLength={250}
              onFocus={() => onActive?.(i)}
              onChange={(e) => set(i, e.target.value)}
            />
            <span
              className={cx(
                "shrink-0 text-[11px] tabular-nums",
                len > 70 ? "text-amber-600 dark:text-amber-400" : "text-faint",
              )}
              title="Under ~60 characters shows fully on most phones"
            >
              {len}
            </span>
            <VariableMenu
              compact
              align="right"
              onInsert={(v) => insert(i, v)}
            />
            {value.length > 1 && (
              <button
                type="button"
                aria-label="Remove subject line"
                onClick={() => remove(i)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-red-500/10 hover:text-red-600"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        );
      })}
      {value.length < MAX_SUBJECTS && (
        <button
          type="button"
          onClick={add}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-brand-600 hover:bg-brand-500/10 dark:text-brand-300"
        >
          <Plus className="h-3.5 w-3.5" /> Add subject line{" "}
          <span className="text-muted">
            ({value.length}/{MAX_SUBJECTS})
          </span>
        </button>
      )}
    </div>
  );
}
