import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertOctagon,
  CheckCheck,
  ChevronLeft,
  History,
  ExternalLink,
  Inbox as InboxIcon,
  Info,
  MailOpen,
  MousePointerClick,
  MoreHorizontal,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { get, post, qs } from "../../api/client.js";
import { STALE, invalidate } from "../../lib/query.js";
import {
  Avatar,
  Badge,
  Button,
  ConfirmButton,
  Empty,
  ErrorBox,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  Segmented,
  cx,
  fmt,
  toast,
} from "../../components/ui.jsx";
import EmailFrame from "../../components/EmailFrame.jsx";
import ReplyBox from "../../components/ReplyBox.jsx";
import { splitQuotedHtml, splitQuotedText } from "../../lib/emailQuote.js";

function useDebounced(value, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Message body with the quoted earlier conversation hidden behind "•••" (like Gmail). */
function MessageBody({ m }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const parts = useMemo(
    () => (m.html ? splitQuotedHtml(m.html) : splitQuotedText(m.text)),
    [m.html, m.text],
  );
  useEffect(() => setShowQuoted(false), [m.id]);
  const toggle = parts.quoted && (
    <button
      type="button"
      onClick={() => setShowQuoted((v) => !v)}
      title={showQuoted ? "Hide quoted text" : "Show trimmed content"}
      className="mt-2 inline-flex h-6 items-center rounded-md bg-slate-200/80 px-2 text-slate-600 transition hover:bg-slate-300 dark:bg-white/10 dark:text-slate-300 dark:hover:bg-white/20"
    >
      <MoreHorizontal className="h-4 w-4" />
    </button>
  );
  if (m.html) {
    return (
      <div>
        <div className="rounded-xl bg-white p-3">
          <EmailFrame
            html={showQuoted ? `${parts.main}${parts.quoted}` : parts.main}
          />
        </div>
        {toggle}
      </div>
    );
  }
  return (
    <div>
      <pre className="whitespace-pre-wrap rounded-xl bg-white p-4 font-sans text-sm leading-relaxed text-slate-800">
        {showQuoted ? `${parts.main}\n\n${parts.quoted}` : parts.main}
      </pre>
      {toggle}
    </div>
  );
}

const LEADS = [
  ["INTERESTED", "Interested", "green"],
  ["MEETING", "Meeting", "blue"],
  ["NOT_INTERESTED", "Not interested", "gray"],
  ["WRONG_PERSON", "Wrong person", "gray"],
  ["OUT_OF_OFFICE", "Out of office", "yellow"],
  ["OTHER", "Other", "gray"],
];
const leadOf = (k) => LEADS.find(([v]) => v === k);

/** Quick keyword guess so the employee can mark a reply in one tap (never set automatically, except out-of-office). */
function suggestLead(m) {
  if (m.isAutoReply) return "OUT_OF_OFFICE";
  const t =
    `${m.subject || ""}\n${(m.text || "").split(/\n\s*(>|On .{3,200} wrote:)/)[0]}`.toLowerCase();
  if (
    /\b(not interested|no thanks|no, thanks|remove me|unsubscribe|stop (emailing|sending)|don'?t (email|contact))/.test(
      t,
    )
  )
    return "NOT_INTERESTED";
  if (
    /\b(wrong person|not the right person|no longer (work|with)|left the company|contact (my colleague|[a-z]+ instead))/.test(
      t,
    )
  )
    return "WRONG_PERSON";
  if (
    /\b(call|meeting|meet|schedule|calendar|zoom|teams|available (on|at)|tomorrow|next week|what time)\b/.test(
      t,
    )
  )
    return "MEETING";
  if (
    /\b(interested|sounds good|tell me more|send (me )?(the )?(details|info|brochure|proposal|quote|price)|pricing|how much|okay|ok+|sure|yes)\b/.test(
      t,
    )
  )
    return "INTERESTED";
  return null;
}

function LeadPicker({ message, value, onChange }) {
  const suggestion = !value ? suggestLead(message) : null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted">Result:</span>
      {LEADS.filter(
        ([k]) => k !== "OUT_OF_OFFICE" || message.isAutoReply || value === k,
      ).map(([k, l]) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(value === k ? null : k)}
          className={cx(
            "rounded-full border px-2.5 py-1 text-xs font-medium transition",
            value === k
              ? "border-transparent bg-inv text-inv-fg"
              : suggestion === k
                ? "border-brand-400 bg-brand-500/10 text-brand-700 dark:text-brand-300"
                : "border-line text-fg2 hover:border-brand-400",
          )}
        >
          {value === k && "✓ "}
          {l}
          {suggestion === k && " ?"}
        </button>
      ))}
      {suggestion && (
        <span className="text-[11px] text-muted">
          suggested — tap to confirm
        </span>
      )}
    </div>
  );
}

function ThreadItem({ t, onOpen }) {
  if (t.kind === "YOU_REPLIED") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-3xl rounded-tr-md bg-brand-500/10 px-4 py-3 text-sm">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Send className="h-3.5 w-3.5" />
            You replied · {fmt.date(t.at)}
          </div>
          <div className="mt-1 whitespace-pre-wrap text-fg">{t.text}</div>
        </div>
      </div>
    );
  }
  if (t.kind === "SENT") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-3xl rounded-tr-md bg-brand-500/10 px-4 py-3 text-sm">
          <div className="flex items-center gap-2 text-xs text-muted">
            <Send className="h-3.5 w-3.5" />
            You sent{t.campaign?.type === "FOLLOWUP"
              ? " a follow-up"
              : ""} · {fmt.date(t.at)}
          </div>
          <div className="mt-1 font-medium text-fg">{t.subject}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            from {t.from}
            {t.campaign && (
              <>
                {" "}
                ·{" "}
                <Link
                  className="text-brand-600 hover:underline dark:text-brand-300"
                  to={`/app/campaigns/${t.campaign.id}`}
                >
                  {t.campaign.name}
                </Link>
              </>
            )}
            {t.openedAt && (
              <Badge color="blue">
                <MailOpen className="mr-1 inline h-3 w-3" />
                Opened
              </Badge>
            )}
            {t.clickedAt && (
              <Badge color="green">
                <MousePointerClick className="mr-1 inline h-3 w-3" />
                Clicked
              </Badge>
            )}
            {t.status === "BOUNCED" && <Badge color="red">Bounced</Badge>}
          </div>
        </div>
      </div>
    );
  }
  if (t.current) return null;
  return (
    <button
      type="button"
      onClick={() => onOpen(t.id)}
      className="flex w-full max-w-[80%] items-center gap-3 rounded-3xl rounded-tl-md bg-subtle px-4 py-3 text-left text-sm transition hover:bg-subtle-2"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted">
          {t.kind === "BOUNCE"
            ? "Bounce notice"
            : t.kind === "AUTO"
              ? "Automatic reply"
              : "Earlier reply"}{" "}
          · {fmt.date(t.at)}
          {t.folder === "SPAM" ? " · in Spam" : ""}
        </span>
        <span className="block truncate font-medium text-fg">
          {t.subject || "(no subject)"}
        </span>
      </span>
      <span className="text-xs text-brand-600 dark:text-brand-300">Open</span>
    </button>
  );
}

export default function Inbox() {
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [openId, setOpenId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [syncing, setSyncing] = useState(false);
  const [olderOpen, setOlderOpen] = useState(false);
  const [olderBusy, setOlderBusy] = useState(0);
  const fetchOlder = async (days) => {
    setOlderBusy(days);
    try {
      const r = await post("/api/inbox/fetch-older", { days });
      setOlderOpen(false);
      toast.ok(
        r.mailboxes
          ? `Fetching replies from the last ${days} days in ${r.mailboxes} mailbox${r.mailboxes === 1 ? "" : "es"}. They appear here over the next few minutes.`
          : "No mailbox with reply checking (IMAP) is connected",
      );
      setTimeout(() => invalidate("inbox", "dashboard"), 30_000);
    } catch (err) {
      toast.error(err);
    } finally {
      setOlderBusy(0);
    }
  };

  const list = useQuery({
    queryKey: ["inbox", { page, tab, q }],
    queryFn: () =>
      get(
        `/api/inbox${qs({
          page,
          pageSize: 25,
          search: q || undefined,
          unread: tab === "unread" ? "true" : undefined,
          spam: tab === "spam" ? "true" : undefined,
          lead: tab === "interested" ? "interested" : undefined,
          bounces:
            tab === "bounces" ? "true" : tab === "spam" ? undefined : "false",
        })}`,
      ),
    staleTime: STALE.inbox,
    refetchInterval: 60_000,
  });
  const msg = useQuery({
    queryKey: ["message", openId],
    queryFn: async () => {
      const r = await get(`/api/inbox/${openId}`);
      invalidate("inbox", "dashboard");
      return r;
    },
    enabled: Boolean(openId),
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    setSelected(new Set());
  }, [page, tab, q]);

  const items = list.data?.items || [];
  const m = msg.data?.message;
  const allChecked = items.length > 0 && items.every((x) => selected.has(x.id));
  const toggle = (id) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const readAll = async () => {
    await post("/api/inbox/read-all");
    invalidate("inbox", "dashboard");
  };
  const checkNow = async () => {
    setSyncing(true);
    try {
      const r = await post("/api/inbox/sync");
      invalidate("inbox", "dashboard", "campaigns");
      if (r.errors?.length)
        toast.error(
          new Error(
            `Couldn't read ${r.errors.map((e) => e.email).join(", ")}: ${r.errors[0].error}`,
          ),
        );
      else if (!r.accounts)
        toast.error(
          new Error("No mailbox with reply checking (IMAP) is connected"),
        );
      else
        toast.ok(
          r.replies || r.bounces
            ? `Found ${r.replies} new repl${r.replies === 1 ? "y" : "ies"}${r.bounces ? ` and ${r.bounces} bounce${r.bounces === 1 ? "" : "s"}` : ""}`
            : `Checked ${r.checked} mailbox${r.checked === 1 ? "" : "es"} (inbox and spam) — nothing new`,
        );
    } catch (err) {
      toast.error(err);
    } finally {
      setSyncing(false);
    }
  };
  const setLead = async (leadStatus) => {
    try {
      await post(`/api/inbox/${openId}/status`, { leadStatus });
      invalidate(["message", openId], "inbox", "responses");
      if (leadStatus) toast.ok(`Marked as ${leadOf(leadStatus)[1]}`);
    } catch (err) {
      toast.error(err);
    }
  };
  const remove = async (ids) => {
    try {
      const r = await post("/api/inbox/delete", { ids });
      if (ids.includes(openId)) setOpenId(null);
      setSelected(new Set());
      invalidate("inbox", "dashboard");
      toast.ok(`Deleted ${r.deleted} message${r.deleted === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Replies and bounces from your inbox and spam folders, matched to their campaigns (by reply headers or by the sender's address)."
        actions={
          <>
            <Button
              variant="outline"
              icon={RefreshCw}
              onClick={checkNow}
              loading={syncing}
            >
              {syncing ? "Checking…" : "Check now"}
            </Button>
            <Button
              variant="outline"
              icon={History}
              onClick={() => setOlderOpen(true)}
            >
              Fetch older emails
            </Button>
            <Button variant="outline" icon={CheckCheck} onClick={readAll}>
              Mark all read
            </Button>
          </>
        }
      />
      <Modal
        open={olderOpen}
        onClose={() => setOlderOpen(false)}
        title="Fetch older emails"
      >
        <p className="text-sm text-muted">
          Emails Pro re-reads the inbox and spam folders of all your connected
          mailboxes and adds replies it missed. Replies already here are not
          duplicated.
        </p>
        <p className="mt-2 text-sm text-muted">
          Only replies from people you emailed in a campaign are shown — other
          mail stays in your mailbox.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {[30, 90, 180].map((d) => (
            <Button
              key={d}
              variant={d === 30 ? "brand" : "secondary"}
              loading={olderBusy === d}
              disabled={Boolean(olderBusy)}
              onClick={() => fetchOlder(d)}
            >
              Last {d} days
            </Button>
          ))}
        </div>
        <p className="mt-3 text-xs text-faint">
          Large mailboxes are read 100 emails at a time, so this can take a few
          minutes. You can use the app meanwhile.
        </p>
      </Modal>
      <div className="card grid min-h-[640px] overflow-hidden lg:grid-cols-[380px_1fr]">
        <aside
          className={cx(
            "border-b border-line p-4 lg:border-b-0 lg:border-r",
            openId && "hidden lg:block",
          )}
        >
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              className="input h-12 rounded-full pl-11"
              placeholder="Search by email or subject"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="mt-3 overflow-x-auto">
            <Segmented
              size="sm"
              value={tab}
              onChange={(v) => {
                setTab(v);
                setPage(1);
              }}
              options={[
                ["all", "All"],
                [
                  "unread",
                  `Unread${list.data?.unread ? ` · ${list.data.unread}` : ""}`,
                ],
                ["interested", "Interested"],
                ["spam", "Spam"],
                ["bounces", "Bounces"],
              ]}
            />
          </div>
          {items.length > 0 && (
            <div className="mt-3 flex h-8 items-center justify-between px-1 text-xs text-muted">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() =>
                    setSelected(
                      allChecked ? new Set() : new Set(items.map((x) => x.id)),
                    )
                  }
                />
                {selected.size ? `${selected.size} selected` : "Select all"}
              </label>
              {selected.size > 0 && (
                <ConfirmButton
                  size="sm"
                  variant="ghost"
                  confirm={`Delete ${selected.size}?`}
                  onConfirm={() => remove([...selected])}
                >
                  <Trash2 className="mr-1 inline h-3.5 w-3.5" />
                  Delete
                </ConfirmButton>
              )}
            </div>
          )}
          <div className="mt-1 space-y-1">
            {list.isLoading && !list.data ? (
              <Loading />
            ) : items.length === 0 ? (
              <Empty
                icon={InboxIcon}
                title={q ? "No matches" : "Nothing here yet"}
              >
                {q ? (
                  "Try another email address or subject."
                ) : (
                  <>
                    Mailboxes are checked every few minutes. Press{" "}
                    <b>Check now</b> to look straight away.
                  </>
                )}
              </Empty>
            ) : (
              items.map((x) => (
                <div
                  key={x.id}
                  className={cx(
                    "group relative flex items-start gap-2 rounded-2xl px-2 py-3 transition",
                    openId === x.id ? "bg-subtle" : "hover:bg-subtle/60",
                  )}
                >
                  {openId === x.id && (
                    <span className="absolute top-3 bottom-3 -left-4 w-1 rounded-r bg-brand-500" />
                  )}
                  <input
                    type="checkbox"
                    className="mt-3 shrink-0"
                    checked={selected.has(x.id)}
                    onChange={() => toggle(x.id)}
                    aria-label="Select message"
                  />
                  <button
                    type="button"
                    onClick={() => setOpenId(x.id)}
                    className="flex min-w-0 flex-1 items-start gap-3 text-left"
                  >
                    <Avatar name={x.fromAddr} online={!x.isBounce} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span
                          className={cx(
                            "truncate text-sm",
                            !x.isRead
                              ? "font-semibold text-fg"
                              : "font-medium text-fg2",
                          )}
                        >
                          {x.isBounce ? "Delivery failure" : x.fromAddr}
                        </span>
                        <span className="shrink-0 text-[11px] text-faint">
                          {fmt.rel(x.receivedAt)}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-fg2">
                        {x.subject || "(no subject)"}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5">
                        <span className="min-w-0 truncate text-xs text-muted">
                          {x.snippet}
                        </span>
                        {x.folder === "SPAM" && (
                          <Badge color="yellow">Spam</Badge>
                        )}
                        {x.isAutoReply && !x.leadStatus && (
                          <Badge color="yellow">Auto-reply</Badge>
                        )}
                        {x.leadStatus && (
                          <Badge color={leadOf(x.leadStatus)?.[2]}>
                            {leadOf(x.leadStatus)?.[1]}
                          </Badge>
                        )}
                        {!x.isRead && (
                          <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-brand-500" />
                        )}
                      </span>
                    </span>
                  </button>
                </div>
              ))
            )}
          </div>
          {list.data && (
            <Pagination
              page={page}
              pageSize={25}
              total={list.data.total}
              onPage={setPage}
            />
          )}
          {list.error && <ErrorBox error={list.error} />}
        </aside>

        <section
          className={cx(
            "flex min-h-[560px] flex-col",
            !openId && "hidden lg:flex",
          )}
        >
          {!openId ? (
            <div className="dot-grid flex flex-1 items-center justify-center">
              <Empty icon={InboxIcon} title="Select a conversation">
                Choose a reply on the left to read it.
              </Empty>
            </div>
          ) : msg.isLoading ? (
            <Loading />
          ) : msg.error ? (
            <div className="p-6">
              <ErrorBox error={msg.error} />
            </div>
          ) : (
            <>
              <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <button
                    type="button"
                    className="lg:hidden"
                    onClick={() => setOpenId(null)}
                    aria-label="Back"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <Avatar name={m.fromAddr} online={!m.isBounce} />
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{m.fromAddr}</div>
                    <div className="truncate text-xs text-muted">
                      to {m.account.email}
                      {msg.data.campaign && (
                        <>
                          {" "}
                          ·{" "}
                          <Link
                            className="text-brand-600 hover:underline dark:text-brand-300"
                            to={`/app/campaigns/${msg.data.campaign.id}`}
                          >
                            {msg.data.campaign.name}
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {m.isBounce && (
                    <Badge color="red">
                      <AlertOctagon className="mr-1 inline h-3 w-3" />
                      Bounce
                    </Badge>
                  )}
                  {m.folder === "SPAM" && (
                    <Badge color="yellow">
                      <ShieldAlert className="mr-1 inline h-3 w-3" />
                      Found in Spam
                    </Badge>
                  )}
                  {msg.data.campaign && (
                    <Link to={`/app/campaigns/${msg.data.campaign.id}`}>
                      <Button variant="secondary" size="sm" icon={ExternalLink}>
                        Campaign
                      </Button>
                    </Link>
                  )}
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    confirm="Delete?"
                    onConfirm={() => remove([m.id])}
                  >
                    <Trash2 className="h-4 w-4" />
                  </ConfirmButton>
                </div>
              </header>
              <div className="dot-grid flex-1 space-y-4 overflow-y-auto px-5 py-6">
                {(msg.data.thread || [])
                  .filter(
                    (t) =>
                      !t.current && new Date(t.at) <= new Date(m.receivedAt),
                  )
                  .map((t, i) => (
                    <ThreadItem
                      key={`${t.kind}-${t.id || i}`}
                      t={t}
                      onOpen={setOpenId}
                    />
                  ))}
                <div className="flex justify-center">
                  <span className="rounded-full bg-subtle px-3 py-1 text-xs text-muted">
                    {fmt.day(m.receivedAt)}
                  </span>
                </div>
                <div className="max-w-[760px] rounded-3xl rounded-tl-md bg-subtle p-4">
                  <div className="mb-3 flex items-start justify-between gap-3 px-1">
                    <div className="font-semibold text-fg">
                      {m.subject || "(no subject)"}
                    </div>
                    <div className="shrink-0 text-[11px] text-faint">
                      {fmt.time(m.receivedAt)}
                    </div>
                  </div>
                  <MessageBody m={m} />
                </div>
                {(msg.data.thread || [])
                  .filter(
                    (t) =>
                      !t.current && new Date(t.at) > new Date(m.receivedAt),
                  )
                  .map((t, i) => (
                    <ThreadItem
                      key={`${t.kind}-after-${t.id || i}`}
                      t={t}
                      onOpen={setOpenId}
                    />
                  ))}
              </div>
              <footer className="space-y-3 border-t border-line p-3 sm:p-4">
                {m.isBounce ? (
                  <div className="flex items-center gap-3 rounded-full bg-subtle px-5 py-3 text-sm text-muted">
                    <Info className="h-4 w-4 shrink-0" />
                    This address is suppressed automatically and won’t be
                    emailed again.
                  </div>
                ) : (
                  <>
                    {m.recipientId && (
                      <LeadPicker
                        message={m}
                        value={msg.data.leadStatus}
                        onChange={setLead}
                      />
                    )}
                    {m.isAutoReply && (
                      <p className="text-xs text-muted">
                        Automatic reply (e.g. out of office) — not counted as a
                        reply, so this person still gets your follow-ups.
                      </p>
                    )}
                    <ReplyBox
                      message={m}
                      onSent={() => invalidate(["message", openId], "inbox")}
                    />
                  </>
                )}
              </footer>
            </>
          )}
        </section>
      </div>
    </>
  );
}
