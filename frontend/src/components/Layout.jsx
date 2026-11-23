import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  AtSign,
  BarChart3,
  Bell,
  ChevronDown,
  CircleHelp,
  FileText,
  FlaskConical,
  History,
  Inbox,
  LayoutGrid,
  LogOut,
  Mail,
  Moon,
  PlusCircle,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sun,
  User,
  Users,
  Activity,
  Ban,
  ScrollText,
  Gauge,
  CheckCircle2,
  AlertTriangle,
  PauseCircle,
  Info,
  ArrowRight,
  Menu,
  X,
} from "lucide-react";
import { get, post } from "../api/client.js";
import { useAuth } from "../store/auth.js";
import { useConnection } from "../store/connection.js";
import { useTheme } from "../store/theme.js";
import { invalidate } from "../lib/query.js";
import { Avatar, Brand, IconButton, Spinner, cx, fmt } from "./ui.jsx";

// ---------- navigation model ----------
export const NAV = {
  EMPLOYEE: {
    tabs: [
      ["/app", "Overview"],
      ["/app/campaigns", "Campaigns"],
      ["/app/accounts", "Accounts"],
      ["/app/lists", "Recipients"],
      ["/app/pitches", "Pitches"],
      ["/app/inbox", "Inbox"],
      ["/app/analytics", "Analytics"],
      ["/app/history", "History"],
      ["/app/suppressions", "Suppression"],
    ],
    rail: [
      ["/app", "Overview", LayoutGrid],
      ["/app/campaigns/new", "Create campaign", PlusCircle],
      ["/app/inbox", "Inbox", Mail],
      ["/app/pitches", "Pitches", FileText],
      ["/app/lists", "Recipients", Users],
      ["/app/accounts", "Email accounts", AtSign],
      ["/app/settings", "Settings", Settings],
    ],
    actions: [
      ["Create a new campaign", "/app/campaigns/new", Send],
      ["Connect an email account", "/app/accounts?connect=1", AtSign],
      ["Import recipients", "/app/lists", Users],
      ["Write a pitch", "/app/pitches?new=1", FileText],
    ],
    extra: [
      ["/app/profile", "My profile", User],
      ["/app/settings", "Settings", Settings],
      ["/app/help", "Help Center", CircleHelp],
    ],
  },
  ADMIN: {
    tabs: [
      ["/admin", "Overview"],
      ["/admin/employees", "Employees"],
      ["/admin/accounts", "SMTP monitoring"],
      ["/admin/campaigns", "Campaigns"],
      ["/admin/deliverability", "Deliverability"],
      ["/admin/reports", "Reports"],
      ["/admin/health", "Health"],
      ["/admin/audit", "Audit"],
    ],
    rail: [
      ["/admin", "Overview", LayoutGrid],
      ["/admin/employees", "Employees", Users],
      ["/admin/accounts", "SMTP monitoring", AtSign],
      ["/admin/campaigns", "Campaigns", Send],
      ["/admin/health", "System health", Activity],
      ["/admin/settings", "Policies & settings", Settings],
    ],
    actions: [
      ["Add an employee", "/admin/employees?new=1", Users],
      [
        "Review campaigns awaiting approval",
        "/admin/campaigns?status=PENDING_APPROVAL",
        ShieldCheck,
      ],
      ["Check system health", "/admin/health", Gauge],
      ["Change sending policies", "/admin/settings", Settings],
    ],
    extra: [
      ["/admin/profile", "My profile", User],
      ["/admin/settings", "Policies & settings", Settings],
      ["/admin/help", "Help Center", CircleHelp],
      ["/admin/audit", "Audit logs", ScrollText],
    ],
  },
};
const PAGE_ICONS = {
  Overview: LayoutGrid,
  Campaigns: Send,
  Accounts: AtSign,
  Recipients: Users,
  Pitches: FileText,
  Inbox,
  Analytics: BarChart3,
  History,
  Suppression: Ban,
  Employees: Users,
  "SMTP monitoring": AtSign,
  Deliverability: FlaskConical,
  Reports: BarChart3,
  Health: Activity,
  Audit: ScrollText,
};

// ---------- connection banner ----------
export function ConnectionBanner() {
  const { status, attempt, lastOkAt } = useConnection();
  if (status === "online") return null;
  return (
    <div
      className={cx(
        "flex items-center justify-center gap-2 px-4 py-2 text-sm",
        status === "waking"
          ? "bg-amber-500/15 text-amber-800 dark:text-amber-200"
          : "bg-red-500/15 text-red-700 dark:text-red-300",
      )}
      role="status"
    >
      {status === "waking" ? (
        <>
          <Spinner className="h-3.5 w-3.5" /> Connecting to Emails Pro… the
          server may be waking up from sleep, which can take up to a minute
          {attempt > 1 ? ` (attempt ${attempt})` : ""}.
          {lastOkAt ? " Showing cached data meanwhile." : ""}
        </>
      ) : (
        <>
          Emails Pro is unreachable right now.
          {lastOkAt ? " Showing cached data;" : ""} Actions will be available
          once it reconnects — refresh to try again.
        </>
      )}
    </div>
  );
}

// ---------- theme switch (rail) ----------
export function ThemeSwitch({ vertical = true }) {
  const { resolved, setMode } = useTheme();
  return (
    <div
      className={cx(
        "pill flex gap-1 p-1.5",
        vertical ? "flex-col" : "flex-row",
      )}
    >
      <IconButton
        icon={Sun}
        label="Light mode"
        active={resolved === "light"}
        onClick={() => setMode("light")}
        className={resolved === "light" ? "!bg-subtle-2 !text-fg" : ""}
      />
      <IconButton
        icon={Moon}
        label="Dark mode"
        active={resolved === "dark"}
        onClick={() => setMode("dark")}
        className={resolved === "dark" ? "!bg-subtle-2 !text-fg" : ""}
      />
    </div>
  );
}

// ---------- command palette ----------
function CommandPalette({ open, onClose, nav }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const inputRef = useRef(null);
  const items = useMemo(() => {
    const actions = nav.actions.map(([label, to, icon]) => ({
      group: "Actions",
      label,
      hint: "Quick action",
      to,
      icon,
    }));
    const pages = [
      ...nav.tabs.map(([to, label]) => ({
        to,
        label,
        icon: PAGE_ICONS[label] || LayoutGrid,
      })),
      ...nav.extra.map(([to, label, icon]) => ({ to, label, icon })),
    ]
      .filter((p, idx, arr) => arr.findIndex((x) => x.to === p.to) === idx)
      .map((p) => ({ ...p, group: "Pages", hint: "Go to page" }));
    const all = [...actions, ...pages];
    const s = q.trim().toLowerCase();
    return s ? all.filter((x) => x.label.toLowerCase().includes(s)) : all;
  }, [q, nav]);

  useEffect(() => {
    if (open) {
      setQ("");
      setI(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);
  useEffect(() => {
    setI(0);
  }, [q]);
  if (!open) return null;
  const go = (it) => {
    onClose();
    navigate(it.to);
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setI((x) => Math.min(items.length - 1, x + 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setI((x) => Math.max(0, x - 1));
    }
    if (e.key === "Enter" && items[i]) go(items[i]);
    if (e.key === "Escape") onClose();
  };
  let lastGroup = null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-xl animate-pop overflow-hidden rounded-3xl bg-card shadow-2xl ring-1 ring-line"
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <Search className="h-5 w-5 text-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search pages and actions…"
            className="flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-faint"
          />
          <kbd className="rounded-md border border-line px-1.5 py-0.5 text-[10px] text-muted">
            esc
          </kbd>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-2">
          {items.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted">
              No results for “{q}”
            </div>
          )}
          {items.map((it, idx) => {
            const header =
              it.group !== lastGroup ? (lastGroup = it.group) : null;
            const I = it.icon;
            return (
              <div key={it.group + it.to + it.label}>
                {header && (
                  <div className="px-3 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
                    {header}
                  </div>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setI(idx)}
                  onClick={() => go(it)}
                  className={cx(
                    "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left",
                    idx === i && "bg-subtle",
                  )}
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-subtle-2 text-fg2">
                    <I className="h-4 w-4" />
                  </span>
                  <span className="flex-1">
                    <span className="block text-sm font-medium text-fg">
                      {it.label}
                    </span>
                    <span className="block text-xs text-muted">{it.hint}</span>
                  </span>
                  {idx === i && <ArrowRight className="h-4 w-4 text-muted" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex gap-4 border-t border-line px-5 py-2.5 text-[11px] text-muted">
          <span>
            <kbd className="rounded border border-line px-1">↑</kbd>{" "}
            <kbd className="rounded border border-line px-1">↓</kbd> to move
          </span>
          <span>
            <kbd className="rounded border border-line px-1">↵</kbd> to open
          </span>
          <span>
            <kbd className="rounded border border-line px-1">⌘</kbd>{" "}
            <kbd className="rounded border border-line px-1">K</kbd> anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------- dropdown helper ----------
function useOutside(ref, onOut, active) {
  useEffect(() => {
    if (!active) return undefined;
    const h = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onOut();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [ref, onOut, active]);
}

const NOTIF_ICON = (type = "") => {
  if (/completed|approved|recovered|released/.test(type))
    return [
      CheckCircle2,
      "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    ];
  if (/paused|hold|resumed/.test(type))
    return [PauseCircle, "bg-amber-500/15 text-amber-600 dark:text-amber-400"];
  if (/fail|down|unhealthy|emergency|rejected/.test(type))
    return [AlertTriangle, "bg-red-500/15 text-red-600 dark:text-red-400"];
  return [Info, "bg-brand-500/15 text-brand-600 dark:text-brand-300"];
};

function Notifications({ home }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => get("/api/notifications"),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const markRead = async () => {
    await post("/api/notifications/read", {});
    invalidate("notifications");
  };
  return (
    <div className="relative" ref={ref}>
      <IconButton
        icon={Bell}
        label="Notifications"
        onClick={() => setOpen((o) => !o)}
      />
      {data?.unread ? (
        <span className="pointer-events-none absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-brand-500 ring-2 ring-card" />
      ) : null}
      {open && (
        <div className="absolute right-0 z-50 mt-3 w-[360px] animate-pop overflow-hidden rounded-3xl bg-card shadow-2xl ring-1 ring-line">
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <span className="text-[15px] font-semibold">Notifications</span>
            {data?.unread ? (
              <button
                type="button"
                className="text-sm font-medium text-brand-600 dark:text-brand-300"
                onClick={markRead}
              >
                Mark all as read
              </button>
            ) : null}
          </div>
          <ul className="max-h-[380px] overflow-y-auto px-2 pb-2">
            {(data?.items || []).length === 0 && (
              <li className="px-3 py-10 text-center text-sm text-muted">
                You're all caught up
              </li>
            )}
            {(data?.items || []).map((n) => {
              const [I, tone] = NOTIF_ICON(n.type);
              return (
                <li
                  key={n.id}
                  className="flex gap-3 rounded-2xl px-3 py-2.5 hover:bg-subtle"
                >
                  <span
                    className={cx(
                      "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                      tone,
                    )}
                  >
                    <I className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-fg">
                      {n.title}
                    </span>
                    {n.body && (
                      <span className="block truncate text-xs text-muted">
                        {n.body}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1.5 text-[11px] text-faint">
                    {fmt.rel(n.createdAt)}
                    {!n.readAt && (
                      <span className="h-2 w-2 rounded-full bg-brand-500" />
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <Link
            to={home}
            onClick={() => setOpen(false)}
            className="m-2 mt-0 flex items-center justify-center gap-1 rounded-2xl bg-subtle py-3 text-sm font-medium text-fg hover:bg-subtle-2"
          >
            Go to overview <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      )}
    </div>
  );
}

function ProfileMenu({ user, nav, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="pill flex h-12 items-center gap-1.5 py-1.5 pl-1.5 pr-2 sm:h-[60px] sm:gap-3 sm:py-2 sm:pl-2.5 sm:pr-4"
      >
        <Avatar name={user.name} online />
        <span className="hidden min-w-0 text-left lg:block">
          <span className="block max-w-[150px] truncate text-sm font-semibold text-fg">
            {user.name}
          </span>
          <span className="block max-w-[150px] truncate text-xs text-muted">
            {user.email}
          </span>
        </span>
        <ChevronDown
          className={cx(
            "hidden h-4 w-4 text-muted transition sm:block",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-3 w-72 animate-pop overflow-hidden rounded-3xl bg-card p-2 shadow-2xl ring-1 ring-line">
          <div className="flex items-center gap-3 border-b border-line px-3 pb-3 pt-2">
            <Avatar name={user.name} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{user.name}</div>
              <div className="truncate text-xs text-muted">
                {user.role === "ADMIN"
                  ? "Administrator"
                  : user.title || "Employee"}{" "}
                · {user.email}
              </div>
            </div>
          </div>
          <div className="py-1">
            {nav.extra.map(([to, label, I]) => (
              <Link
                key={to}
                to={to}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-fg2 hover:bg-subtle hover:text-fg"
              >
                <I className="h-4 w-4" />
                {label}
              </Link>
            ))}
          </div>
          <div className="border-t border-line pt-1">
            <button
              type="button"
              onClick={onLogout}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-red-600 hover:bg-red-500/10 dark:text-red-400"
            >
              <LogOut className="h-4 w-4" />
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- shell ----------
export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const nav = NAV[user.role];
  const home = user.role === "ADMIN" ? "/admin" : "/app";
  const [palette, setPalette] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);

  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => {
    setMobileNav(false);
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  const doLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };
  const tabActive = (to) =>
    to === home
      ? location.pathname === home
      : location.pathname === to || location.pathname.startsWith(`${to}/`);
  const railActive = (to) =>
    to === home
      ? location.pathname === home
      : location.pathname === to ||
        (to !== "/app/campaigns/new" && location.pathname.startsWith(`${to}/`));

  return (
    <div className="min-h-screen">
      <ConnectionBanner />
      <div className="mx-auto max-w-[1440px] px-3 pb-28 pt-4 sm:px-6 md:pb-10 lg:px-8">
        {/* top bar */}
        <header className="sticky top-3 z-40 flex min-w-0 items-center gap-1.5 sm:gap-3">
          <Link
            to={home}
            aria-label="Home"
            className="pill flex h-12 shrink-0 items-center px-2.5 sm:h-[60px] sm:px-4"
          >
            <span className="hidden sm:inline-flex">
              <Brand compact={false} />
            </span>
            <span className="inline-flex sm:hidden">
              <Brand compact />
            </span>
          </Link>
          <nav className="pill hidden h-[60px] min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 lg:flex [&::-webkit-scrollbar]:hidden">
            {nav.tabs.map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                className={cx(
                  "shrink-0 rounded-full px-4 py-2.5 text-[15px] transition",
                  tabActive(to)
                    ? "bg-inv font-medium text-inv-fg"
                    : "text-fg2 hover:bg-subtle hover:text-fg",
                )}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="flex-1 lg:hidden" />
          <div className="pill flex h-12 shrink-0 items-center gap-0 px-1 sm:h-[60px] sm:gap-0.5 sm:px-2">
            <IconButton
              icon={Search}
              label="Search (Ctrl/⌘ K)"
              onClick={() => setPalette(true)}
            />
            <Notifications home={home} />
            <IconButton
              icon={AlertCircle}
              label="Help Center"
              onClick={() => navigate(`${home}/help`)}
              className="hidden sm:inline-flex"
            />
            <IconButton
              icon={mobileNav ? X : Menu}
              label="Menu"
              onClick={() => setMobileNav((m) => !m)}
              className="lg:hidden"
            />
          </div>
          <ProfileMenu user={user} nav={nav} onLogout={doLogout} />
        </header>

        {mobileNav && (
          <nav className="card mt-3 grid animate-pop grid-cols-2 gap-1 p-2 lg:hidden">
            {nav.tabs.map(([to, label]) => (
              <NavLink
                key={to}
                to={to}
                onClick={() => setMobileNav(false)}
                className={cx(
                  "rounded-2xl px-4 py-3 text-sm",
                  tabActive(to)
                    ? "bg-inv text-inv-fg"
                    : "text-fg2 hover:bg-subtle",
                )}
              >
                {label}
              </NavLink>
            ))}
            <div className="col-span-2 mt-1 flex items-center justify-between border-t border-line px-2 pt-2 md:hidden">
              <span className="text-sm text-muted">Theme</span>
              <ThemeSwitch vertical={false} />
            </div>
            <button
              type="button"
              onClick={doLogout}
              className="col-span-2 rounded-2xl px-4 py-3 text-left text-sm text-red-600 hover:bg-subtle md:hidden"
            >
              Log out
            </button>
          </nav>
        )}

        <div className="mt-6 flex gap-6">
          {/* left rail */}
          <aside className="sticky top-[96px] hidden h-fit shrink-0 flex-col gap-4 md:flex">
            <ThemeSwitch />
            <div className="pill flex flex-col gap-1.5 p-1.5">
              {nav.rail.map(([to, label, I]) => (
                <NavLink
                  key={to}
                  to={to}
                  title={label}
                  aria-label={label}
                  className={cx(
                    "inline-flex h-10 w-10 items-center justify-center rounded-full transition",
                    railActive(to)
                      ? "bg-inv text-inv-fg"
                      : "text-fg2 hover:bg-subtle hover:text-fg",
                  )}
                >
                  <I className="h-[18px] w-[18px]" strokeWidth={1.8} />
                </NavLink>
              ))}
            </div>
            <div className="pill flex flex-col gap-1.5 p-1.5">
              <NavLink
                to={`${home}/help`}
                title="Help Center"
                className={({ isActive }) =>
                  cx(
                    "inline-flex h-10 w-10 items-center justify-center rounded-full transition",
                    isActive
                      ? "bg-inv text-inv-fg"
                      : "text-fg2 hover:bg-subtle hover:text-fg",
                  )
                }
              >
                <CircleHelp className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </NavLink>
              <IconButton icon={LogOut} label="Log out" onClick={doLogout} />
            </div>
          </aside>

          <main className="min-w-0 flex-1">
            <Outlet />
          </main>
        </div>
      </div>
      <nav
        aria-label="Quick navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card/95 backdrop-blur md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto flex max-w-md justify-around px-1">
          {nav.rail.slice(0, 5).map(([to, label, I]) => (
            <NavLink
              key={to}
              to={to}
              aria-label={label}
              className={cx(
                "flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[11px]",
                railActive(to)
                  ? "font-semibold text-brand-600 dark:text-sky-400"
                  : "text-muted",
              )}
            >
              <I className="h-5 w-5" strokeWidth={railActive(to) ? 2.2 : 1.8} />
              <span className="max-w-full truncate">
                {label
                  .replace("Create campaign", "New")
                  .replace("Email accounts", "Accounts")
                  .replace("SMTP monitoring", "SMTP")}
              </span>
            </NavLink>
          ))}
        </div>
      </nav>
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        nav={nav}
      />
    </div>
  );
}
