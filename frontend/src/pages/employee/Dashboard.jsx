import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AtSign, MailCheck, MessageSquareReply, Plus, Search, Send, ShieldAlert, TriangleAlert } from 'lucide-react';
import { get } from '../../api/client.js';
import { STALE } from '../../lib/query.js';
import { useAuth } from '../../store/auth.js';
import { StackedBars, lastNDays } from '../../components/Charts.jsx';
import { Button, Card, ErrorBox, Loading, Meter, Notice, PageHeader, Stat, StatusBadge, Table, cx, fmt, greeting } from '../../components/ui.jsx';

export default function Dashboard() {
  const user = useAuth((s) => s.user);
  const [q, setQ] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['dashboard'], queryFn: () => get('/api/reports/dashboard'), staleTime: STALE.dashboard });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => get('/api/smtp-accounts'), staleTime: STALE.accounts });
  const analytics = useQuery({ queryKey: ['analytics', 14], queryFn: () => get('/api/reports/analytics?days=14'), staleTime: STALE.stats });

  if (isLoading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const t = data.last30Days || {};
  const quotaPct = data.quota.dailyLimit ? Math.round((data.quota.sentToday / data.quota.dailyLimit) * 100) : 0;
  const chart = lastNDays(14, analytics.data?.daily, (r) => ({ top: r.sent || 0, bottom: r.replied || 0 }));
  const recent = data.recent.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  const accs = (accounts.data?.accounts || []).slice(0, 3);

  return (
    <>
      <PageHeader title={`${greeting()}, ${user.name.split(' ')[0]}`} subtitle="Track your campaigns, protect your sender reputation and keep every conversation moving." />

      {data.tracking && data.tracking.enabled && !data.tracking.reachable && (
        <Notice tone="info" className="mb-5"><b>Opens and clicks show 0 while testing on this computer.</b> Tracking links point to {data.tracking.url}, which recipients' mail apps can't reach. They are counted once Emails Pro runs on its public web address. Replies and bounces are detected either way.</Notice>
      )}
      {(data.sending.globalPaused || data.sending.disabled) && (
        <Notice tone="warn" className="mb-5">{data.sending.globalPaused ? 'Sending is paused system-wide by the administrator.' : 'Sending is disabled for your account by the administrator.'} Campaigns will wait until it is re-enabled.</Notice>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_1fr_1.05fr]">
        {/* Today */}
        <section className="card flex flex-col p-6 animate-fade-up">
          <div className="flex items-center justify-between"><span className="text-[15px] text-fg2">Sent today</span><span className="rounded-full bg-subtle px-3 py-1 text-xs text-muted">UTC day</span></div>
          <div className="mt-3 flex items-end gap-2"><span className="text-[40px] font-semibold leading-none tracking-tight">{fmt.num(data.quota.sentToday)}</span><span className="pb-1 text-muted">/ {fmt.num(data.quota.dailyLimit)}</span></div>
          <div className="mt-2 flex items-center gap-2 text-sm text-muted"><span className={cx('rounded-md px-1.5 py-0.5 text-xs font-medium', quotaPct >= 90 ? 'bg-red-500/12 text-red-600' : 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400')}>{quotaPct}%</span> of your daily limit</div>
          <div className="mt-5 flex gap-3">
            <Link to="/app/campaigns/new" className="flex-1"><Button size="lg" className="w-full" icon={Plus}>New Campaign</Button></Link>
            <Link to="/app/accounts?connect=1" className="flex-1"><Button size="lg" variant="secondary" className="w-full" icon={AtSign}>Add Account</Button></Link>
          </div>
          <div className="mt-5 flex-1 rounded-3xl bg-subtle p-4">
            <div className="mb-3 text-sm"><b className="font-medium">Accounts</b> <span className="text-muted">| {data.accounts.total} of {data.accounts.limit} connected</span></div>
            <div className="grid grid-cols-3 gap-2.5">
              {accs.map((a) => (
                <div key={a.id} className="min-w-0 rounded-2xl bg-card p-3">
                  <div className="flex items-center gap-1.5"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-500 text-[10px] font-semibold uppercase text-white">{a.email[0]}</span><span className="truncate text-xs font-medium">{a.email.split('@')[0]}</span></div>
                  <div className="mt-2 text-sm font-semibold">{a.usage.day}<span className="text-xs font-normal text-muted"> / {a.limits.daily}</span></div>
                  <div className="truncate text-[10px] text-faint">{a.limits.hourly}/h · {a.provider.toLowerCase().replace('_', ' ')}</div>
                  <div className={cx('mt-1.5 text-xs font-medium', a.status === 'CONNECTED' ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>{a.status === 'CONNECTED' ? 'Active' : a.status.toLowerCase()}</div>
                </div>
              ))}
              {accs.length === 0 && <Link to="/app/accounts?connect=1" className="col-span-3 rounded-2xl border border-dashed border-line p-4 text-center text-sm text-muted hover:text-fg">Connect your first mailbox →</Link>}
            </div>
          </div>
        </section>

        {/* KPI tiles */}
        <section className="card grid grid-cols-2 gap-4 p-4 animate-fade-up [animation-delay:.06s]">
          <Stat highlight label="Emails sent" value={fmt.num(t.sent)} icon={Send} footer={<span className="rounded-md bg-white/20 px-1.5 py-0.5 font-medium">30 days</span>} />
          <Stat label="Replies" value={fmt.num(t.replied)} icon={MessageSquareReply} footer={<span className="rounded-md bg-emerald-500/12 px-1.5 py-0.5 font-medium text-emerald-600 dark:text-emerald-400">{fmt.pct(t.replied, t.sent)}</span>} hint="reply rate" />
          <Stat label="Working campaigns" value={<>{data.campaigns.working}<span className="text-lg text-muted">/{data.campaigns.limit}</span></>} icon={MailCheck} hint={`${Math.max(0, data.campaigns.limit - data.campaigns.working)} slots left`} />
          <Stat label="Bounce rate" value={fmt.pct(t.bounced, t.sent)} icon={ShieldAlert} tone={t.sent && t.bounced / t.sent > 0.05 ? 'bad' : undefined}
            footer={<span className="rounded-md bg-subtle-2 px-1.5 py-0.5 font-medium">{fmt.num(t.bounced)}</span>} hint="bounced" />
        </section>

        {/* Chart */}
        <section className="card p-6 animate-fade-up [animation-delay:.12s]">
          <h2 className="text-xl font-semibold">Sending overview</h2>
          <p className="mt-1 text-sm text-muted">Emails sent and replies over the last 14 days</p>
          <div className="mt-4 rounded-3xl bg-subtle p-4">
            <div className="mb-2 flex items-center justify-between text-sm"><b className="font-medium">Sent vs Replied</b><span className="flex gap-3 text-xs text-muted"><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#4f6ffb]" />Sent</span><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-fg" />Replied</span></span></div>
            <StackedBars data={chart} height={230} />
          </div>
        </section>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_2.05fr]">
        <section className="card p-6">
          <h2 className="text-[17px] font-semibold">Daily sending quota</h2>
          <div className="mt-5"><Meter value={data.quota.sentToday} max={data.quota.dailyLimit} showNumbers={false} /></div>
          <div className="mt-3 flex justify-between text-sm"><span><b>{fmt.num(data.quota.sentToday)}</b> <span className="text-muted">sent out of</span></span><b>{fmt.num(data.quota.dailyLimit)}</b></div>
          <div className="mt-6 grid grid-cols-3 gap-2 text-center">
            {[['Unread replies', data.unreadReplies, '/app/inbox'], ['Unknown', t.unknown, '/app/campaigns'], ['On hold', t.onHold, '/app/campaigns']].map(([l, v, to]) => (
              <Link key={l} to={to} className="rounded-2xl bg-subtle px-2 py-3 hover:bg-subtle-2"><div className="text-xl font-semibold">{fmt.num(v || 0)}</div><div className="text-[11px] text-muted">{l}</div></Link>
            ))}
          </div>
          {(t.unknown > 0 || t.onHold > 0) && <p className="mt-4 flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300"><TriangleAlert className="h-4 w-4 shrink-0" />Some sends need your review — open the campaign to resolve them.</p>}
        </section>

        <Card title="Recent campaigns" padded={false} actions={(
          <div className="relative"><Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" /><input className="input h-11 w-56 rounded-full pl-10" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        )}>
          <Table head={['Campaign', 'Status', 'Progress', 'Sent', 'Replies', 'Issues']} empty={!recent.length && <div className="p-8 text-center text-sm text-muted">No campaigns yet. <Link className="text-brand-600 dark:text-brand-300" to="/app/campaigns/new">Create one →</Link></div>}>
            {recent.map((c) => (
              <tr key={c.id} className="hover:bg-subtle/60">
                <td className="td"><Link className="font-medium hover:underline" to={`/app/campaigns/${c.id}`}>{c.name}</Link><div className="text-xs text-faint">{c.type === 'FOLLOWUP' ? 'Follow-up' : 'Fresh'}</div></td>
                <td className="td"><StatusBadge status={c.status} /></td>
                <td className="td w-40"><Meter kind="progress" label={`${c.stats.completion}%`} value={c.stats.total - c.stats.pending - c.stats.sending} max={c.stats.total} /></td>
                <td className="td">{c.stats.sent}</td>
                <td className="td">{c.stats.replied}</td>
                <td className="td text-xs text-muted">{[c.stats.failed && `${c.stats.failed} failed`, c.stats.bounced && `${c.stats.bounced} bounced`, c.stats.unknown && `${c.stats.unknown} unknown`].filter(Boolean).join(' · ') || '—'}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
      <p className="mt-3 text-xs text-faint">Opens and clicks are approximate (image blocking, privacy proxies and link scanners affect them).</p>
    </>
  );
}