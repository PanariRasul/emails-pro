import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AtSign, ChevronDown, LifeBuoy, Search, Send, ShieldCheck, Users, Gauge } from 'lucide-react';
import { useAuth } from '../../store/auth.js';
import { PageHeader, cx } from '../../components/ui.jsx';

const FAQ = [
  ['accounts', 'Why can\'t my Zoho / Yahoo account send?', 'On the free hosting plan the server cannot open SMTP ports 465/587. Use Google sign-in for Gmail/Workspace, the Amazon SES API, or an SMTP relay on port 2525 — or ask your admin to move the backend to a paid instance.'],
  ['accounts', 'How do I connect Gmail?', 'Accounts → Connect account → Gmail → “Sign in with Google”. Emails Pro sends through the Gmail API and reads replies over IMAP. No password is stored.'],
  ['campaigns', 'Why is my campaign sending slowly?', 'Every mailbox has one shared limiter: all campaigns using it share the hourly limit. New mailboxes also warm up gradually. The campaign page shows the estimate and any reason it is waiting.'],
  ['campaigns', 'What does “unknown outcome” mean?', 'The connection dropped after the message was handed to the mail server, so it may already be delivered. Emails Pro never resends automatically — it checks your Sent folder, or you choose Mark sent / Mark failed / Retry.'],
  ['campaigns', 'How do I add clients quickly?', 'Paste email addresses — one per line, separated by commas, or copied from Gmail (“Ravi Kumar <ravi@acme.com>”) or Excel — into Recipients → Add contacts, or directly in Create campaign → Recipients → Paste emails. You can also upload an .xlsx or .csv file; download the sample Excel or CSV to collect data in the right format. Duplicates and invalid addresses are removed for you.'],
  ['campaigns', 'Where do names come from if I only paste emails?', 'Emails Pro fills missing first names and companies from the address: ravi.kumar@acme-tools.com → Ravi Kumar, Acme Tools. Filled values show in italics so you can correct them. Role addresses (info@, sales@) and free mailboxes (Gmail, Yahoo) get no guessed name or company. Write {{firstName|there}} in your pitch so those people get “Hi there,”.'],
  ['campaigns', 'How do I write a pitch?', 'Pitches → New pitch. Type or paste your email into the editor — no HTML needed. Use the toolbar for bold, italic, underline, highlight, colours, text size, lists and links, and “Variables” to insert {{firstName}} or {{companyName}}. Press Format to tidy pasted text: even paragraph spacing, greeting and signature on their own lines, bullet lists and clickable links. Preview shows the email on desktop and mobile with sample data.'],
  ['campaigns', 'Can a pitch have several subject lines?', 'Yes, up to 10. When you create a campaign from the pitch, either pick one subject or switch on “Rotate all subject lines” so recipients get them in turn. Follow-ups keep each person’s own subject in the same thread.'],
  ['campaigns', 'Can one campaign send from several accounts?', 'Yes. In Create campaign → Send from, tick as many accounts as you like (or click a group such as “Gmail” or “All”). Recipients are split evenly: 500 recipients over 10 accounts = 50 each. The speed you choose applies to each account, and no account ever goes over its own limits. If an account stops working or reaches its limit, its unsent emails move automatically to the other selected accounts.'],
  ['accounts', 'What are account groups?', 'A group is a label such as “Gmail”, “Zoho team” or “Yahoo”. Set it when connecting an account, with Edit, or tick several accounts on the Email accounts page and press “Set group”. In Create campaign, click a group to select all its accounts at once.'],
  ['accounts', 'Which name is used to sign my emails?', 'Each account has a “Sender name” (set when connecting it, or with Edit). It is shown as the From name and filled in wherever your pitch says {{senderName}}. If it is empty, the email address is used.'],
  ['campaigns', 'Why do opens and clicks show 0?', 'Opens and clicks are counted when the recipient’s mail app loads a tiny image or opens a tracked link on Emails Pro’s public web address. While you test on your own computer (localhost), mail apps can’t reach it, so they stay at 0 — the campaign page shows a note. Once deployed they work. Opens are approximate (image blocking, Apple Mail Privacy Protection). Replies and bounces are detected from your mailbox either way.'],
  ['campaigns', 'How are bounces detected?', 'Invalid addresses rejected while sending are marked Bounced straight away. Bounce notices that arrive later (“Address not found”, “Undelivered mail”) are read from your inbox and spam folders, matched to the email, and the address is suppressed so it’s never emailed again.'],
  ['campaigns', 'How quickly do replies appear in the Inbox?', 'Every connected mailbox (inbox and Spam/Junk folder) is checked every few minutes. Press “Check now” on the Inbox page to check immediately. Click ••• under a reply to show the earlier messages it quotes. Delete hides a message from Emails Pro; the person still counts as replied.'],
  ['limits', 'How does warm-up work?', 'A newly connected account starts at 20% of its normal limits on day 1 and rises evenly every day until it reaches its full limits on day 10 (for example 100 → 144 → 189 … → 500 emails a day). The account shows “warm-up day 3/10” until it finishes. Your administrator can change the start percentage and number of days, switch warm-up off for a trusted account, or restart it.'],
  ['campaigns', 'How many campaigns can I run?', 'Up to 7 working campaigns (draft, scheduled, sending or paused). Archive completed or cancelled ones to free a slot.'],
  ['campaigns', 'How do follow-ups work?', 'Open a campaign that has sent emails → Create follow-up. Each person gets the follow-up from the SAME account that sent them the first email, in the same thread. If that account is removed, disabled or not working, the follow-up fails for that person — it is never sent from another account. Replied, bounced and unsubscribed people are left out automatically.'],
  ['security', 'I didn\'t get my sign-in code', 'Check spam, wait 45 seconds and press “Resend code”. Codes expire after 10 minutes. If it still doesn\'t arrive, ask your admin to check the OTP mailbox in Login security.'],
  ['security', 'I forgot my password', 'Use “Forgot password?” on the sign-in page to receive a reset code by email, or ask your administrator to reset it.'],
  ['security', 'Can my admin read my mailbox?', 'No. Credentials are encrypted and never shown. Admins see sending statistics and can pause campaigns, but cannot send as you or read your mailbox.'],
  ['team', 'Why are opens lower or higher than expected?', 'Open tracking is approximate: image blocking, Apple Mail Privacy Protection and security scanners distort it. Replies are the most reliable signal.'],
  ['team', 'What happens when someone unsubscribes?', 'The address is suppressed across the whole organisation immediately, and any pending emails to it are skipped.'],
  ['limits', 'Who sets my sending limits?', 'Your administrator. Settings → Sending limits shows the values that apply to you.'],
];
const CATS = [
  ['accounts', 'Email accounts', 'Connecting and fixing mailboxes', AtSign],
  ['campaigns', 'Campaigns', 'Sending, follow-ups and results', Send],
  ['security', 'Security', 'Sign-in codes and passwords', ShieldCheck],
  ['team', 'Tracking & compliance', 'Opens, clicks and unsubscribes', Users],
  ['limits', 'Limits', 'Daily, hourly and warm-up', Gauge],
];

export default function Help() {
  const user = useAuth((s) => s.user);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(null);
  const [open, setOpen] = useState(0);
  const items = useMemo(() => FAQ.filter(([c, t, a]) => (!cat || c === cat) && (!q || `${t} ${a}`.toLowerCase().includes(q.toLowerCase()))), [q, cat]);
  const home = user.role === 'ADMIN' ? '/admin' : '/app';
  return (
    <>
      <PageHeader title="Help Center" subtitle="Answers and guides when you need them." />
      <section className="relative overflow-hidden rounded-[32px] bg-card px-6 py-14 text-center" style={{ boxShadow: 'var(--shadow)' }}>
        <div className="pointer-events-none absolute left-1/2 top-0 h-56 w-[560px] -translate-x-1/2 rounded-full bg-brand-500/30 blur-3xl" />
        <h2 className="relative text-3xl font-semibold tracking-tight">How can we help, today?</h2>
        <div className="relative mx-auto mt-6 max-w-xl">
          <Search className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-white/60 dark:text-black/50" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for answers — e.g. “follow-up”" className="h-14 w-full rounded-full bg-inv pl-14 pr-6 text-[15px] text-inv-fg shadow-xl outline-none placeholder:text-white/50 dark:placeholder:text-black/40" />
        </div>
        <div className="relative mt-4 flex flex-wrap items-center justify-center gap-2 text-sm text-muted">Popular:
          {['unknown', 'follow-up', 'code', 'Zoho'].map((p) => <button key={p} type="button" onClick={() => setQ(p)} className="rounded-full bg-subtle px-3 py-1 text-fg2 hover:bg-subtle-2">{p}</button>)}
        </div>
      </section>

      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {CATS.map(([id, t, d, I]) => (
          <button key={id} type="button" onClick={() => setCat(cat === id ? null : id)} className={cx('card p-5 text-left transition hover:-translate-y-0.5', cat === id && 'ring-2 ring-brand-500')}>
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-500/10 text-brand-600 dark:text-brand-300"><I className="h-5 w-5" /></span>
            <div className="mt-4 font-semibold">{t}</div>
            <div className="mt-1 text-sm text-muted">{d}</div>
            <div className="mt-3 text-xs text-faint">{FAQ.filter((f) => f[0] === id).length} articles</div>
          </button>
        ))}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[2fr_1fr]">
        <section className="card p-6">
          <h2 className="mb-4 text-xl font-semibold">Frequently asked</h2>
          <div className="space-y-2">
            {items.length === 0 && <p className="py-6 text-center text-sm text-muted">No answers match “{q}”.</p>}
            {items.map(([, t, a], i) => (
              <div key={t} className="rounded-2xl bg-subtle">
                <button type="button" onClick={() => setOpen(open === i ? -1 : i)} className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left font-medium">{t}<ChevronDown className={cx('h-4 w-4 shrink-0 transition', open === i && 'rotate-180')} /></button>
                {open === i && <p className="animate-pop px-5 pb-5 text-sm leading-relaxed text-fg2">{a}</p>}
              </div>
            ))}
          </div>
        </section>
        <section className="card h-fit p-6">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl brand-gradient text-white"><LifeBuoy className="h-6 w-6" /></span>
          <h2 className="mt-4 text-xl font-semibold">Still stuck?</h2>
          <p className="mt-2 text-sm text-muted">{user.role === 'ADMIN' ? 'Check System health and the Audit log, or see docs/OPERATIONS.md in the project for the runbook.' : 'Your administrator can check your account limits, mailbox health and sign-in settings.'}</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link to="/how-to-use" className="rounded-full bg-inv px-4 py-2.5 text-sm font-medium text-inv-fg">Read the guide</Link>
            {user.role === 'ADMIN' && <Link to={`${home}/health`} className="rounded-full bg-subtle px-4 py-2.5 text-sm font-medium">System health</Link>}
          </div>
        </section>
      </div>
    </>
  );
}