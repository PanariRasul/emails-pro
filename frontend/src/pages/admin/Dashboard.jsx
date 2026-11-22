import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AtSign, Octagon, Play, Send, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { get, post } from '../../api/client.js';
import { STALE, invalidate } from '../../lib/query.js';
import { useAuth } from '../../store/auth.js';
import { StackedBars, lastNDays } from '../../components/Charts.jsx';
import { Avatar, Button, Card, ConfirmButton, ErrorBox, Loading, Notice, PageHeader, Stat, Table, cx, fmt, greeting, toast } from '../../components/ui.jsx';

export default function AdminDashboard() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'dashboard'], queryFn: () => get('/api/admin/dashboard'), staleTime: STALE.admin });
  const reports = useQuery({ queryKey: ['admin', 'reports', 14], queryFn: () => get('/api/admin/reports?days=14'), staleTime: STALE.admin });
  const emergency = async (stop) => {
    try { await post('/api/admin/emergency', { scope: 'global', stop }); invalidate('admin'); toast.ok(stop ? 'All sending stopped' : 'Sending resumed'); } catch (err) { toast.error(err); }
  };
  if (isLoading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const chart = lastNDays(14, reports.data?.daily, (r) => ({ top: r.sent || 0, bottom: r.replied || 0 }));
  const top = (reports.data?.perEmployee || []).slice(0, 6);
  const w = data.worker;

  return (
    <>
      <PageHeader title={`${greeting()}, ${user.name.split(' ')[0]}`} subtitle="Employees, mailboxes and sending activity across Emails Pro." />
      {data.globalSendingPaused && <Notice tone="danger" className="mb-5">Global sending is <b>stopped</b>. No emails will be sent until you resume.</Notice>}

      <div className="grid gap-5 xl:grid-cols-[1fr_1fr_1.05fr]">
        <section className="card flex flex-col p-6 animate-fade-up">
          <div className="text-[15px] text-fg2">Emails sent · last 24 hours</div>
          <div className="mt-3 text-[40px] font-semibold leading-none tracking-tight">{fmt.num(data.last24h.sent)}</div>
          <div className="mt-2 flex items-center gap-2 text-sm text-muted"><span className={cx('rounded-md px-1.5 py-0.5 text-xs font-medium', data.last24h.bounced ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400')}>{fmt.pct(data.last24h.bounced, data.last24h.sent)}</span> bounce rate</div>
          <div className="mt-5 flex gap-3">
            <Button size="lg" className="flex-1" icon={UserPlus} onClick={() => navigate('/admin/employees?new=1')}>Add Employee</Button>
            {data.globalSendingPaused
              ? <Button size="lg" variant="brand" className="flex-1" icon={Play} onClick={() => emergency(false)}>Resume</Button>
              : <ConfirmButton size="lg" variant="secondary" className="flex-1" icon={Octagon} confirm="Stop all?" onConfirm={() => emergency(true)}>Emergency stop</ConfirmButton>}
          </div>
          <div className="mt-5 flex-1 rounded-3xl bg-subtle p-4">
            <div className="mb-3 text-sm"><b className="font-medium">System</b> <span className="text-muted">| live status</span></div>
            <div className="grid grid-cols-3 gap-2.5">
              {[
                ['Worker', w.leader ? 'Running' : w.enabled ? 'Standby' : 'Off', `tick ${fmt.rel(w.lastTickAt)}`, w.leader],
                ['Unknown', data.unknownSends, 'awaiting review', data.unknownSends === 0],
                ['Approvals', data.pendingApproval, 'pending', data.pendingApproval === 0],
              ].map(([l, v, sub, ok]) => (
                <div key={l} className="rounded-2xl bg-card p-3">
                  <div className="text-xs font-medium text-fg2">{l}</div>
                  <div className="mt-2 text-lg font-semibold">{v}</div>
                  <div className="truncate text-[10px] text-faint">{sub}</div>
                  <div className={cx('mt-1 text-xs font-medium', ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>{ok ? 'Healthy' : 'Attention'}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card grid grid-cols-2 gap-4 p-4 animate-fade-up [animation-delay:.06s]">
          <Stat highlight label="Active employees" value={data.employees.true || 0} icon={Users} footer={<span className="rounded-md bg-white/20 px-1.5 py-0.5 font-medium">{data.employees.false || 0}</span>} hint="deactivated" />
          <Stat label="Connected accounts" value={data.accounts.CONNECTED || 0} icon={AtSign} footer={<span className={cx('rounded-md px-1.5 py-0.5 font-medium', data.accounts.ERROR ? 'bg-red-500/12 text-red-600' : 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400')}>{data.accounts.ERROR || 0}</span>} hint={`in error · ${sum(data.accounts)} total`} />
          <Stat label="Campaigns sending" value={data.campaigns.SENDING || 0} icon={Send} hint={`${data.campaigns.SCHEDULED || 0} scheduled · ${data.campaigns.PAUSED || 0} paused`} />
          <Stat label="Awaiting approval" value={data.pendingApproval} icon={ShieldCheck} hint={data.pendingApproval ? <Link className="font-medium text-brand-600 dark:text-brand-300" to="/admin/campaigns?status=PENDING_APPROVAL">Review now →</Link> : 'Nothing to review'} />
        </section>

        <section className="card p-6 animate-fade-up [animation-delay:.12s]">
          <h2 className="text-xl font-semibold">Sending overview</h2>
          <p className="mt-1 text-sm text-muted">All employees · last 14 days</p>
          <div className="mt-4 rounded-3xl bg-subtle p-4">
            <div className="mb-2 flex items-center justify-between text-sm"><b className="font-medium">Sent vs Replied</b><span className="flex gap-3 text-xs text-muted"><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-[#4f6ffb]" />Sent</span><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-fg" />Replied</span></span></div>
            <StackedBars data={chart} height={230} />
          </div>
        </section>
      </div>

      <div className="mt-5">
        <Card title="Top employees" subtitle="Last 14 days" padded={false} actions={<Link to="/admin/reports"><Button variant="outline" size="sm">Full report</Button></Link>}>
          <Table head={['Employee', 'Sent', 'Replied', 'Reply rate', 'Bounced', 'Failed']} empty={!top.length && <div className="p-8 text-center text-sm text-muted">No sending activity yet.</div>}>
            {top.map((e) => (
              <tr key={e.id}>
                <td className="td"><Link to={`/admin/employees/${e.id}`} className="flex items-center gap-3"><Avatar name={e.name} size="sm" /><span><span className="block font-medium hover:underline">{e.name}</span><span className="text-xs text-muted">{e.email}</span></span></Link></td>
                <td className="td">{e.sent}</td><td className="td">{e.replied}</td><td className="td">{fmt.pct(e.replied, e.sent)}</td><td className="td">{e.bounced}</td><td className="td">{e.failed}</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
