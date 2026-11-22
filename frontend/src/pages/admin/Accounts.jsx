import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, patch, post, qs } from '../../api/client.js';
import { STALE, invalidate } from '../../lib/query.js';
import { Badge, Button, Card, ErrorBox, Field, Loading, Meter, Modal, PageHeader, Pagination, StatusBadge, Table, Toggle, fmt, toast } from '../../components/ui.jsx';

const n = (v) => (v === '' || v == null ? null : Number(v));

function PolicyModal({ account, onClose }) {
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (account) setF({ maxHourly: account.maxHourly ?? '', maxDaily: account.maxDaily ?? '', warmupEnabled: account.warmupEnabled, warmupStartPercent: account.warmupStartPercent ?? '', warmupDays: account.warmupDays ?? '', restartWarmup: false });
  }, [account]);
  if (!account) return null;
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await patch(`/api/admin/accounts/${account.id}`, { maxHourly: n(f.maxHourly), maxDaily: n(f.maxDaily), warmupEnabled: f.warmupEnabled, warmupStartPercent: n(f.warmupStartPercent), warmupDays: n(f.warmupDays), restartWarmup: f.restartWarmup });
      invalidate('admin'); toast.ok('Account policy saved'); onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title={`Sending policy — ${account.email}`} footer={<Button loading={busy} onClick={save}>Save</Button>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Max emails/hour" hint="Blank = employee limit"><input className="input" type="number" min="0" value={f.maxHourly} onChange={set('maxHourly')} /></Field>
        <Field label="Max emails/day" hint="Blank = employee limit"><input className="input" type="number" min="0" value={f.maxDaily} onChange={set('maxDaily')} /></Field>
        <div className="md:col-span-2"><Toggle checked={f.warmupEnabled} onChange={(v) => setF((s) => ({ ...s, warmupEnabled: v }))} label="Warm-up enabled" /></div>
        <Field label="Start at (% of normal limit)" hint="Day 1 volume. Blank = system default (20%)"><input className="input" type="number" min="1" max="100" value={f.warmupStartPercent} onChange={set('warmupStartPercent')} /></Field>
        <Field label="Warm-up length (days)" hint="Full limit on this day. Blank = system default (10)"><input className="input" type="number" min="1" max="90" value={f.warmupDays} onChange={set('warmupDays')} /></Field>
        {account.limits.warmup && <p className="md:col-span-2 text-xs text-brand-700 dark:text-brand-300">Now on day {account.limits.warmup.day} of {account.limits.warmup.totalDays}: {account.limits.warmup.percent}% → {account.limits.daily}/day of {account.limits.fullDaily}/day.</p>}
        <div className="md:col-span-2"><Toggle checked={f.restartWarmup} onChange={(v) => setF((s) => ({ ...s, restartWarmup: v }))} label="Restart warm-up from today" /></div>
      </div>
      <p className="mt-3 text-xs text-muted">The lowest of system, employee, account, warm-up and health limits always applies. Warm-up should reflect the provider, the domain's history and its limits — on shared provider IPs only the account/domain behaviour can be managed.</p>
      <div className="mt-2"><ErrorBox error={error} /></div>
    </Modal>
  );
}

export default function AdminAccounts() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'accounts', { page, status, search }], queryFn: () => get(`/api/admin/accounts${qs({ page, pageSize: 25, status, search })}`), staleTime: STALE.admin });
  const action = async (fn, msg) => { try { await fn(); invalidate('admin'); toast.ok(msg); } catch (err) { toast.error(err); } };
  return (
    <>
      <PageHeader title="SMTP monitoring" subtitle="Connection health, usage and per-account sending policy for every employee mailbox" />
      <Card padded={false} title="Accounts" actions={(
        <>
          <input className="input w-48" placeholder="Search email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <select className="input w-36" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{['CONNECTED', 'ERROR', 'PAUSED', 'DISABLED', 'PENDING'].map((s) => <option key={s}>{s}</option>)}</select>
        </>
      )}>
        {error && <ErrorBox error={error} />}
        {isLoading && !data ? <Loading /> : (
          <Table head={['Account', 'Employee', 'Status', 'SMTP/IMAP', 'Today', 'Limits', 'Health', '']}>
            {(data?.items || []).map((a) => (
              <tr key={a.id}>
                <td className="td">{a.email}<div className="text-xs text-muted">{a.provider.toLowerCase()} · tested {fmt.rel(a.lastTestAt)}</div></td>
                <td className="td text-sm">{a.owner.name}</td>
                <td className="td"><StatusBadge status={a.status} /></td>
                <td className="td text-xs">{a.smtpOk ? '✓' : '✗'} / {a.imapHost ? (a.imapOk ? '✓' : '✗') : '—'}</td>
                <td className="td w-40"><Meter label="Daily" value={a.usage.day} max={a.limits.daily} /></td>
                <td className="td text-xs">{a.limits.hourly}/h · {a.limits.daily}/d {a.limits.warmup && <Badge color="blue" title={`${a.limits.warmup.percent}% of the normal limit`}>warm-up day {a.limits.warmup.day}/{a.limits.warmup.totalDays}</Badge>}</td>
                <td className="td text-xs">Bounce {(a.bounceRate * 100).toFixed(1)}%{a.lastError && <div className="max-w-xs text-red-600 dark:text-red-400">{a.lastError}</div>}</td>
                <td className="td"><div className="flex flex-wrap justify-end gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(a)}>Policy</Button>
                  {a.status === 'PAUSED' && <Button size="sm" variant="secondary" onClick={() => action(() => patch(`/api/admin/accounts/${a.id}`, { status: 'CONNECTED' }), 'Account resumed')}>Resume</Button>}
                  {a.status === 'CONNECTED' && <Button size="sm" variant="secondary" onClick={() => action(() => patch(`/api/admin/accounts/${a.id}`, { status: 'PAUSED' }), 'Account paused')}>Pause</Button>}
                  {a.adminDisabled
                    ? <Button size="sm" variant="secondary" onClick={() => action(() => post('/api/admin/emergency', { scope: 'account', id: a.id, stop: false }), 'Account enabled')}>Enable</Button>
                    : <Button size="sm" variant="danger" onClick={() => action(() => post('/api/admin/emergency', { scope: 'account', id: a.id, stop: true }), 'Account disabled')}>Disable</Button>}
                </div></td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />}
      </Card>
      <PolicyModal account={editing} onClose={() => setEditing(null)} />
    </>
  );
}