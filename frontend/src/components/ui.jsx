import { useEffect, useState } from "react";
import { create } from "zustand";
import { ArrowDownRight, ArrowUpRight, Check, X } from "lucide-react";
import { useTheme } from "../store/theme.js";

export function cx(...c) {
  return c.filter(Boolean).join(" ");
}

// ---------- brand ----------
/** Full logo (light/dark artwork from the brand kit). */
export function Logo({ className = "h-10", forceDark = false }) {
  const resolved = useTheme((s) => s.resolved);
  const dark = forceDark || resolved === "dark";
  return (
    <img
      src={dark ? "/brand/logo-dark.webp" : "/brand/logo-light.webp"}
      alt="Emails Pro — Email Marketing Platform"
      className={cx("w-auto select-none", className)}
      draggable="false"
    />
  );
}

/** Compact mark + wordmark for navigation. */
export function Brand({ compact = false, className }) {
  const resolved = useTheme((s) => s.resolved);
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <img
        src={
          resolved === "dark"
            ? "/brand/mark-dark.webp"
            : "/brand/mark-light.webp"
        }
        alt=""
        className={cx("h-9 w-auto select-none")}
        draggable="false"
      />
      {!compact && (
        <span className="font-serif text-[19px] font-bold leading-none tracking-tight text-fg">
          Emails <i className="text-brand-500 dark:text-sky-400">Pro</i>
        </span>
      )}
    </span>
  );
}

const AVATAR_TONES = [
  "from-violet-500 to-indigo-500",
  "from-pink-500 to-rose-500",
  "from-sky-500 to-blue-600",
  "from-emerald-500 to-teal-500",
  "from-amber-500 to-orange-500",
  "from-fuchsia-500 to-purple-600",
];
export function initials(name = "") {
  const p = String(name)
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  return ((p[0]?.[0] || "?") + (p[1]?.[0] || "")).toUpperCase();
}
export function Avatar({ name, size = "md", online }) {
  const tone =
    AVATAR_TONES[
      [...String(name || "")].reduce((s, c) => s + c.charCodeAt(0), 0) %
        AVATAR_TONES.length
    ];
  const sz = {
    sm: "h-8 w-8 text-[11px]",
    md: "h-10 w-10 text-xs",
    lg: "h-20 w-20 text-2xl",
  }[size];
  return (
    <span
      className={cx(
        "relative inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white",
        tone,
        sz,
      )}
    >
      {initials(name)}
      {online && (
        <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-card bg-emerald-500" />
      )}
    </span>
  );
}

// ---------- buttons ----------
const BTN = {
  primary: "bg-inv text-inv-fg hover:opacity-90",
  brand:
    "brand-gradient text-white shadow-lg shadow-brand-500/25 hover:brightness-110",
  secondary: "bg-subtle text-fg hover:bg-subtle-2",
  outline: "border border-line bg-card text-fg hover:bg-subtle",
  danger: "bg-red-600 text-white hover:bg-red-700",
  ghost: "text-muted hover:bg-subtle hover:text-fg",
};

export function Button({
  variant = "primary",
  size = "md",
  loading,
  className,
  children,
  icon: Icon,
  ...props
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium transition active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm"
          ? "h-8 px-3 text-xs"
          : size === "lg"
            ? "h-12 px-6 text-[15px]"
            : "h-10 px-4 text-sm",
        BTN[variant],
        className,
      )}
    >
      {loading ? (
        <Spinner className="h-3.5 w-3.5" />
      ) : (
        Icon && <Icon className="h-4 w-4" strokeWidth={2} />
      )}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className, active, ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        "relative inline-flex h-10 w-10 items-center justify-center rounded-full transition",
        active
          ? "bg-inv text-inv-fg"
          : "text-fg2 hover:bg-subtle hover:text-fg",
        className,
      )}
    >
      <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
    </button>
  );
}

export function Spinner({ className = "h-5 w-5" }) {
  return (
    <span
      className={cx(
        "inline-block animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
      aria-label="Loading"
    />
  );
}

// ---------- layout ----------
export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  padded = true,
}) {
  return (
    <section className={cx("card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-1 sm:px-6">
          <div>
            {title && (
              <h2 className="text-[17px] font-semibold text-fg">{title}</h2>
            )}
            {subtitle && (
              <p className="mt-0.5 text-sm text-muted">{subtitle}</p>
            )}
          </div>
          {actions && (
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className={padded ? "p-5 sm:p-6" : "pt-3"}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 animate-fade-up">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-[40px] sm:leading-[1.1]">
          {title}
        </h1>
        {subtitle && <p className="mt-2 text-[15px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const BADGE = {
  green: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  blue: "bg-brand-500/12 text-brand-700 dark:text-brand-300",
  yellow: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  red: "bg-red-500/12 text-red-600 dark:text-red-400",
  gray: "bg-subtle-2 text-fg2",
  purple: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
};

export function Badge({ color = "gray", children, title }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        BADGE[color],
      )}
    >
      {children}
    </span>
  );
}

const STATUS_COLORS = {
  CONNECTED: "green",
  SENT: "green",
  COMPLETED: "green",
  ACCEPTED: "green",
  SENDING: "blue",
  SCHEDULED: "blue",
  PENDING: "gray",
  DRAFT: "gray",
  STARTED: "blue",
  PAUSED: "yellow",
  PENDING_APPROVAL: "purple",
  ON_HOLD: "yellow",
  UNKNOWN: "purple",
  ERROR: "red",
  FAILED: "red",
  BOUNCED: "red",
  DISABLED: "red",
  CANCELLED: "gray",
  SKIPPED: "gray",
  SUPPRESSED: "gray",
};
export function StatusBadge({ status }) {
  const label = String(status || "")
    .replace(/_/g, " ")
    .toLowerCase();
  return (
    <Badge color={STATUS_COLORS[status] || "gray"}>
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </Badge>
  );
}

/** Up/down delta chip like "↑ 8%". */
export function Delta({ value, suffix = "%", invert = false }) {
  if (value == null || Number.isNaN(value)) return null;
  const up = value >= 0;
  const good = invert ? !up : up;
  const I = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium",
        good
          ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
          : "bg-red-500/12 text-red-600 dark:text-red-400",
      )}
    >
      <I className="h-3 w-3" />
      {Math.abs(value)}
      {suffix}
    </span>
  );
}

/** Stat tile (Clientra style). `highlight` renders the brand-gradient hero tile. */
export function Stat({
  label,
  value,
  hint,
  tone,
  icon: Icon,
  highlight,
  footer,
}) {
  return (
    <div
      className={cx(
        "flex min-h-[150px] flex-col justify-between rounded-3xl p-5 transition",
        highlight
          ? "brand-gradient text-white shadow-xl shadow-brand-500/25"
          : "bg-subtle",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={cx("text-sm", highlight ? "text-white/85" : "text-fg2")}
        >
          {label}
        </div>
        {Icon && (
          <span
            className={cx(
              "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
              highlight ? "bg-white/20" : "bg-card text-fg2",
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={1.8} />
          </span>
        )}
      </div>
      <div
        className={cx(
          "mt-3 text-[30px] font-semibold leading-none tracking-tight",
          tone === "warn"
            ? "text-amber-600 dark:text-amber-400"
            : tone === "bad"
              ? "text-red-600 dark:text-red-400"
              : "",
        )}
      >
        {value ?? "—"}
      </div>
      {(hint || footer) && (
        <div
          className={cx(
            "mt-3 flex items-center gap-2 text-xs",
            highlight ? "text-white/80" : "text-muted",
          )}
        >
          {footer}
          {hint}
        </div>
      )}
    </div>
  );
}

export function Meter({
  value,
  max,
  label,
  kind = "quota",
  showNumbers = true,
}) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const bar =
    kind === "progress"
      ? pct >= 100
        ? "bg-emerald-500"
        : "bg-brand-500"
      : pct >= 90
        ? "bg-red-500"
        : pct >= 70
          ? "bg-amber-500"
          : "bg-brand-500";
  return (
    <div>
      {(label || showNumbers) && (
        <div className="mb-1.5 flex justify-between gap-2 text-xs text-muted">
          <span>{label}</span>
          {showNumbers && (
            <span className="text-fg2">
              {value} / {max}
            </span>
          )}
        </div>
      )}
      <div className="hatch h-2.5 overflow-hidden rounded-full bg-subtle">
        <div
          className={cx("h-full rounded-full transition-all duration-700", bar)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      {label && <span className="label">{label}</span>}
      {children}
      {hint && !error && (
        <span className="mt-1.5 block text-xs text-muted">{hint}</span>
      )}
      {error && (
        <span className="mt-1.5 block text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      )}
    </label>
  );
}

/** Switch toggle (keeps the old Toggle API). */
export function Toggle({ checked, onChange, label, description, disabled }) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-start justify-between gap-4",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm text-fg">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs text-muted">{description}</span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={!!checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full transition",
          checked ? "bg-brand-500" : "bg-subtle-2",
        )}
      >
        <span
          className={cx(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
            checked ? "left-[22px]" : "left-0.5",
          )}
        />
      </button>
    </label>
  );
}

/** Segmented control: options = [[value, label], ...] */
export function Segmented({ value, onChange, options, size = "md" }) {
  return (
    <div className="inline-flex rounded-full bg-subtle p-1">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cx(
            "rounded-full font-medium transition",
            size === "sm" ? "px-3 py-1 text-xs" : "px-4 py-1.5 text-sm",
            value === v
              ? "bg-card text-fg shadow-sm"
              : "text-muted hover:text-fg",
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function Notice({ tone = "info", children, className }) {
  const t = {
    info: "bg-brand-500/10 text-brand-800 dark:text-brand-200",
    warn: "bg-amber-500/12 text-amber-800 dark:text-amber-200",
    danger: "bg-red-500/10 text-red-700 dark:text-red-300",
    success: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    neutral: "bg-subtle text-fg2",
  }[tone];
  return (
    <div className={cx("rounded-2xl px-4 py-3 text-sm", t, className)}>
      {children}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  size,
  headerExtra,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[6vh] backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cx(
          "w-full animate-pop rounded-3xl bg-card shadow-2xl ring-1 ring-line",
          size === "xl" ? "max-w-6xl" : wide ? "max-w-3xl" : "max-w-lg",
        )}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-2">
          <h3 className="text-lg font-semibold text-fg">{title}</h3>
          {headerExtra && <div className="ml-auto mr-2">{headerExtra}</div>}
          <IconButton
            icon={X}
            label="Close"
            onClick={onClose}
            className="h-8 w-8"
          />
        </div>
        <div
          className={cx(
            "overflow-y-auto px-6 py-3",
            size === "xl" ? "max-h-[78vh]" : "max-h-[70vh]",
          )}
        >
          {children}
        </div>
        {footer && (
          <div className="flex justify-end gap-2 px-6 pt-2 pb-5">{footer}</div>
        )}
      </div>
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <Notice tone="danger">
      {error.message || String(error)}
      {Array.isArray(error.details) && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {error.details.map((d, i) => (
            <li key={i}>
              {d.path ? `${d.path}: ` : ""}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </Notice>
  );
}

export function Empty({ title, children, icon: Icon }) {
  return (
    <div className="px-4 py-12 text-center">
      {Icon && (
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-subtle text-muted">
          <Icon className="h-5 w-5" />
        </span>
      )}
      <div className="text-sm font-medium text-fg">{title}</div>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner className="h-4 w-4" /> {label}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-5 py-3 text-xs text-muted">
      <span>
        {total} total · page {page} of {pages}
      </span>
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export function Table({ head, children, empty }) {
  return (
    <div className="overflow-x-auto px-3 pb-2 sm:px-4">
      <table className="min-w-full border-separate border-spacing-0">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className={cx(
                  "th bg-subtle",
                  i === 0 && "rounded-l-xl",
                  i === head.length - 1 && "rounded-r-xl",
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr>td]:border-b [&>tr>td]:border-line [&>tr:last-child>td]:border-0">
          {children}
        </tbody>
      </table>
      {empty}
    </div>
  );
}

export function ConfirmButton({
  confirm = "Are you sure?",
  onConfirm,
  children,
  ...props
}) {
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="inline-flex items-center gap-1">
        <span className="text-xs text-fg2">{confirm}</span>
        <Button
          size="sm"
          variant="danger"
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          Yes
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
          No
        </Button>
      </span>
    );
  }
  return (
    <Button {...props} onClick={() => setAsking(true)}>
      {children}
    </Button>
  );
}

// ---------- toasts ----------
export const useToasts = create((set) => ({
  items: [],
  push: (t) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ items: [...s.items, { id, tone: "ok", ...t }] }));
    setTimeout(
      () => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
      t.tone === "error" ? 7000 : 3500,
    );
  },
}));
export const toast = {
  ok: (message) => useToasts.getState().push({ message, tone: "ok" }),
  error: (err) =>
    useToasts
      .getState()
      .push({ message: err?.message || String(err), tone: "error" }),
};

export function Toasts() {
  const items = useToasts((s) => s.items);
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-80 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cx(
            "pointer-events-auto flex animate-pop items-start gap-2.5 rounded-2xl px-4 py-3 text-sm shadow-2xl",
            t.tone === "error" ? "bg-red-600 text-white" : "bg-inv text-inv-fg",
          )}
        >
          <span
            className={cx(
              "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
              t.tone === "error" ? "bg-white/25" : "bg-emerald-500 text-white",
            )}
          >
            {t.tone === "error" ? (
              <X className="h-3 w-3" />
            ) : (
              <Check className="h-3 w-3" />
            )}
          </span>
          {t.message}
        </div>
      ))}
    </div>
  );
}

export const fmt = {
  date: (d) =>
    d
      ? new Date(d).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "—",
  day: (d) =>
    d
      ? new Date(d).toLocaleDateString(undefined, { dateStyle: "medium" })
      : "—",
  time: (d) =>
    d
      ? new Date(d).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "",
  rel: (d) => {
    if (!d) return "—";
    const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return `${Math.max(0, s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  },
  pct: (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—"),
  num: (n) => (n == null ? "—" : Number(n).toLocaleString()),
};

export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
