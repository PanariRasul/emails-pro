import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../../api/client.js';
import { STALE, invalidate } from '../../lib/query.js';
import { Badge, Button, Card, ErrorBox, Field, Loading, Meter, Modal, PageHeader, StatusBadge, Table, fmt, toast } from '../../components/ui.jsx';
import { EmployeeForm } from './Employees.jsx';

export default function EmployeeDetail() {
  const { id } = useParams();
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'employee', id], queryFn: () => get(`/api/admin/employees/${id}`), staleTime: STALE.admin });
  const [editing, setEditing] = useState(false);
  const [pw, setPw] = useState(null);
  if (isLoading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const { employee: e, accounts, campaigns, activity } = data;
  const resetPw = async () => {
    try { await post(`/api/admin/employees/${id}/reset-password`, { password: pw }); toast.ok('Password reset; employee signed out'); setPw(null); } catch (err) { toast.error(err); }
  };
  const stopEmp = async (stop) => {
    try { await post('/api/admin/emergency', { scope: 'employee', id, stop }); invalidate('admin'); toast.ok(stop ? 'Sending stopped for this employee' : 'Sending re-enabled'); } catch (err) { toast.error(err); }
  };
  return (
    <>
      <PageHeader title={e.name} subtitle={e.email} actions={(
        <>
          <Button variant="secondary" onClick={() => setEditing(true)}>Edit limits</Button>
          <Button variant="secondary" onClick={() => setPw('')}>Reset password</Button>
          {e.sendingDisabled ? <Button variant="brand" onClick={() => stopEmp(false)}>Enable sending</Button> : <Button variant="danger" onClick={() => stopEmp(true)}>Stop sending</Button>}
        </>
      )} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Limits">
          <Meter label="Email accounts" value={accounts.length} max={e.effective.accounts} />
          <div className="mt-3 text-sm">Daily: <b>{e.effective.daily}</b> · Hourly/account: <b>{e.effective.hourly}</b></div>
          <div className="mt-2 space-x-1">{e.requireApproval && <Badge color="purple">approval required</Badge>}{e.sendingDisabled && <Badge color="red">sending disabled</Badge>}{!e.isActive && <Badge color="red">inactive</Badge>}</div>
        </Card>
        <Card title="Recent activity" className="md:col-span-2">
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">{activity.map((a) => <li key={a.id}><span className="text-faint">{fmt.date(a.createdAt)}</span> {a.action}</li>)}</ul>
        </Card>
      </div>
      <Card title="Email accounts" className="mt-4" padded={false}>
        <Table head={['Account', 'Status', 'Today', 'Limits', 'Bounce rate', 'Last error']}>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td className="td">{a.email}<div className="text-xs text-muted">{a.provider}</div></td>
              <td className="td"><StatusBadge status={a.status} /></td>
              <td className="td w-40"><Meter label="Daily" value={a.usage.day} max={a.limits.daily} /></td>
              <td className="td text-xs">{a.limits.hourly}/h · {a.limits.daily}/d {a.limits.warmup && <Badge color="blue" title={`${a.limits.warmup.percent}% of the normal limit`}>warm-up day {a.limits.warmup.day}/{a.limits.warmup.totalDays}</Badge>}</td>
              <td className="td">{(a.bounceRate * 100).toFixed(1)}%</td>
              <td className="td max-w-xs text-xs text-red-600 dark:text-red-400">{a.lastError}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Campaigns (read-only)" className="mt-4" padded={false}>
        <Table head={['Campaign', 'Status', 'Recipients', 'Sent', 'Replied', 'Bounced', 'Created']}>
          {campaigns.map((c) => (
            <tr key={c.id}><td className="td">{c.name}</td><td className="td"><StatusBadge status={c.status} /></td><td className="td">{c.stats.total}</td><td className="td">{c.stats.sent}</td><td className="td">{c.stats.replied}</td><td className="td">{c.stats.bounced}</td><td className="td text-xs">{fmt.date(c.createdAt)}</td></tr>
          ))}
        </Table>
      </Card>
      <EmployeeForm open={editing} employee={e} defaults={{}} onClose={() => setEditing(false)} />
      <Modal open={pw !== null} onClose={() => setPw(null)} title="Reset password" footer={<Button disabled={!pw || pw.length < 10} onClick={resetPw}>Reset</Button>}>
        <Field label="New password" hint="At least 10 characters. The employee will be signed out everywhere."><input className="input" type="password" autoComplete="new-password" value={pw || ''} onChange={(ev) => setPw(ev.target.value)} /></Field>
      </Modal>
    </>
  );
}