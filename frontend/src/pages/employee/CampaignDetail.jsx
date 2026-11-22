import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { del, download, get, patch, post, qs } from '../../api/client.js';
import { STALE, invalidate } from '../../lib/query.js';
import {
  Badge, Button, Card, ConfirmButton, ErrorBox, Field, Loading, Meter, Modal, PageHeader, Pagination, Stat, StatusBadge, Table, fmt, toast,
} from '../../components/ui.jsx';
import RichEditor from '../../components/RichEditor.jsx';
import EmailPreview from '../../components/EmailPreview.jsx';
import AccountPicker from '../../components/AccountPicker.jsx';

const FILTERS = ['', 'PENDING', 'SENT', 'FAILED', 'BOUNCED', 'UNKNOWN', 'ON_HOLD', 'SKIPPED', 'SUPPRESSED'];

function useAction(id) {
  return async (fn, ok) => {
    try {
      const r = await fn();
      invalidate(['campaign', id], ['recipients', id], 'campaigns', 'dashboard');
      if (ok) toast.ok(typeof ok === 'function' ? ok(r) : ok);
      return r;
    } catch (err) { toast.error(err); return null; }
  };
}

function StartModal({ open, onClose, campaign, review }) {
  const [when, setWhen] = useState('now');
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);
  const act = useAction(campaign.id);
  const start = async () => {
    setBusy(true);
    // Not retried automatically: if the network fails, the result is checked by reloading the campaign.
    const r = await act(() => post(`/api/campaigns/${campaign.id}/start`, { scheduledAt: when === 'later' && at ? new Date(at).toISOString() : null }),
      (res) => (res.status === 'PENDING_APPROVAL' ? 'Submitted for admin approval' : res.status === 'SCHEDULED' ? 'Campaign scheduled' : 'Campaign started'));
    setBusy(false);
    if (r) onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="Start campaign" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="brand" loading={busy} onClick={start}>{review?.requireApproval && !campaign.approvedAt ? 'Submit for approval' : when === 'now' ? 'Start sending' : 'Schedule'}</Button></>}>
      <div className="space-y-3 text-sm">
        {review?.estimate && <p className="rounded-2xl bg-subtle p-3">{review.stats.pending} recipients at {review.estimate.ratePerHour}/hour (max {review.estimate.dailyCap}/day) ≈ {review.estimate.hours} sending hours over about {review.estimate.days} day(s).</p>}
        <label className="flex items-center gap-2"><input type="radio" checked={when === 'now'} onChange={() => setWhen('now')} /> Start now</label>
        <label className="flex items-center gap-2"><input type="radio" checked={when === 'later'} onChange={() => setWhen('later')} /> Schedule for later</label>
        {when === 'later' && <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />}
        <p className="text-xs text-muted">On the free hosting plan the server sleeps when idle. Scheduled campaigns start when it is awake; if it was asleep at the scheduled time, sending begins as soon as it wakes. No emails are lost or duplicated.</p>
        {review?.globalPaused && <p className="text-xs text-amber-700 dark:text-amber-300">Sending is currently paused system-wide by the administrator.</p>}
      </div>
    </Modal>
  );
}

function FollowUpModal({ open, onClose, campaign }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [excluded, setExcluded] = useState(new Set());
  const [f, setF] = useState({ name: `${campaign.name} — follow-up`, hourlyRate: Math.min(30, campaign.hourlyRate), mode: 'custom', pitchVersionId: '', html: '', keepThreadSubject: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const elig = useQuery({ queryKey: ['eligible', campaign.id, page], queryFn: () => get(`/api/campaigns/${campaign.id}/follow-up/eligible${qs({ page, pageSize: 25 })}`), enabled: open });
  const pitches = useQuery({ queryKey: ['pitches'], queryFn: () => get('/api/pitches'), enabled: open, staleTime: STALE.lists });
  const toggle = (id) => setExcluded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const body = { name: f.name, hourlyRate: Number(f.hourlyRate), keepThreadSubject: f.keepThreadSubject, excludeIds: [...excluded] };
      if (f.mode === 'pitch') body.pitchVersionId = f.pitchVersionId; else { body.html = f.html; body.subject = f.subject || 'Follow-up'; }
      const r = await post(`/api/campaigns/${campaign.id}/follow-up`, body);
      invalidate('campaigns', 'dashboard');
      toast.ok(`Follow-up draft created with ${r.recipients.inserted} recipients`);
      onClose();
      navigate(`/app/campaigns/${r.campaign.id}`);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const unavailable = (a) => !a || a.deletedAt || a.adminDisabled || a.status !== 'CONNECTED';
  return (
    <Modal open={open} onClose={onClose} wide title="Create follow-up" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="brand" loading={busy} onClick={submit}>Create follow-up draft</Button></>}>
      <div className="space-y-3">
        <p className="rounded-2xl bg-subtle p-3 text-xs text-fg2">Each follow-up is sent from the <b>same mailbox</b> that sent the original email, in the same thread (In-Reply-To / References). Replied, unsubscribed, bounced and suppressed recipients are excluded automatically{elig.data ? ` (${elig.data.excluded} excluded)` : ''}. If an original mailbox is unavailable, the follow-up fails for those recipients — the sender is never switched.</p>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Speed (emails/hour)"><input className="input" type="number" min="1" value={f.hourlyRate} onChange={(e) => setF({ ...f, hourlyRate: e.target.value })} /></Field>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant={f.mode === 'custom' ? 'primary' : 'secondary'} onClick={() => setF({ ...f, mode: 'custom' })}>Write message</Button>
          <Button size="sm" variant={f.mode === 'pitch' ? 'primary' : 'secondary'} onClick={() => setF({ ...f, mode: 'pitch' })}>Use a pitch</Button>
        </div>
        {f.mode === 'pitch' ? (
          <select className="input" value={f.pitchVersionId} onChange={(e) => setF({ ...f, pitchVersionId: e.target.value })}>
            <option value="">Choose a pitch…</option>
            {(pitches.data?.pitches || []).map((p) => <option key={p.id} value={p.latest.id}>{p.name}</option>)}
          </select>
        ) : (
          <div>
            <span className="label">Message</span>
            <RichEditor resetKey={open ? 'followup-open' : 'followup-closed'} initialHtml="" minHeight={160} onChange={(h) => setF((s) => ({ ...s, html: h }))} placeholder="Hi {{firstName}}, just following up on my note below…" />
          </div>
        )}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.keepThreadSubject} onChange={(e) => setF({ ...f, keepThreadSubject: e.target.checked })} /> Keep the original subject ("Re: …") so it stays in the same thread</label>
        <div>
          <div className="label">Recipients ({elig.data?.total ?? '…'} eligible · {excluded.size} removed)</div>
          <div className="max-h-64 overflow-y-auto rounded-2xl border border-line">
            {(elig.data?.items || []).map((r) => (
              <label key={r.id} className="flex items-center justify-between border-b border-line px-3 py-1.5 text-sm last:border-0">
                <span className="flex items-center gap-2"><input type="checkbox" checked={!excluded.has(r.id)} onChange={() => toggle(r.id)} /> {r.email}</span>
                <span className="text-xs text-muted">{r.account?.email} {unavailable(r.account) && <Badge color="yellow">sender unavailable</Badge>}</span>
              </label>
            ))}
          </div>
          {elig.data && <Pagination page={page} pageSize={25} total={elig.data.total} onPage={setPage} />}
        </div>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function TestModal({ open, onClose, campaign }) {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try { await post(`/api/campaigns/${campaign.id}/test`, { to }); toast.ok('Test email sent'); onClose(); } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Send a test email" footer={<Button onClick={send} loading={busy} disabled={!to}>Send test</Button>}>
      <Field label="Send to" hint="Uses the first recipient's personalisation values. Tracking is disabled for tests."><input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
    </Modal>
  );
}

function ChangeAccounts({ campaign, current, onClose }) {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => get('/api/smtp-accounts'), staleTime: STALE.accounts });
  const usable = (accounts.data?.accounts || []).filter((a) => a.status === 'CONNECTED' && !a.adminDisabled);
  const [ids, setIds] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true); setError(null);
    try { await patch(`/api/campaigns/${campaign.id}`, { accountIds: ids }); invalidate(['campaign', campaign.id], ['review', campaign.id], 'campaigns'); toast.ok('Sending accounts updated — unsent emails were re-split'); onClose(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} wide title="Change sending accounts" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy} disabled={!ids.length}>Save</Button></>}>
      {accounts.isLoading ? <Loading /> : <AccountPicker accounts={usable} value={ids.filter((x) => usable.some((a) => a.id === x))} onChange={setIds} recipients={campaign.stats.pending} ratePerAccount={campaign.hourlyRate} />}
      <p className="mt-2 text-xs text-muted">Emails already sent keep their sender. Only unsent recipients are split again.</p>
      <ErrorBox error={error} />
    </Modal>
  );
}

function EditCampaign({ campaign, onClose }) {
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.subject);
  const [html, setHtml] = useState(campaign.html);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const contentChanged = subject !== campaign.subject || html !== campaign.html;
      await patch(`/api/campaigns/${campaign.id}`, { name: name.trim(), ...(contentChanged ? { subject, html } : {}) });
      invalidate(['campaign', campaign.id], ['review', campaign.id], 'campaigns');
      toast.ok('Campaign updated'); onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} size="xl" title="Edit campaign" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="brand" onClick={save} loading={busy} disabled={!name.trim() || !subject.trim()}>Save</Button></>}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Field label="Campaign name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Subject"><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          <div><span className="label">Email body</span><RichEditor initialHtml={campaign.html} resetKey={campaign.id} onChange={setHtml} minHeight={240} /></div>
          {campaign.type === 'FOLLOWUP' && <p className="text-xs text-muted">Follow-ups keep each person’s “Re:” subject when that option was chosen.</p>}
          <ErrorBox error={error} />
        </div>
        <EmailPreview subject={subject} html={html} height={420} />
      </div>
    </Modal>
  );
}

function SendingAccounts({ c, accounts, onChange }) {
  if (!accounts?.length) return null;
  const editable = c.type === 'FRESH' && ['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'PAUSED'].includes(c.status);
  return (
    <Card className="mt-4" padded={false} title={`Sending accounts (${accounts.length})`} actions={editable && <Button size="sm" variant="secondary" onClick={onChange}>Change accounts</Button>}>
      <Table head={['Account', 'Assigned', 'Sent', 'Waiting', 'Failed / bounced', 'Progress']}>
        {accounts.map((a) => {
          const k = a.counts;
          const done = (k.SENT || 0) + (k.FAILED || 0) + (k.BOUNCED || 0) + (k.UNKNOWN || 0) + (k.SKIPPED || 0) + (k.SUPPRESSED || 0);
          return (
            <tr key={a.id}>
              <td className="td"><div className="font-medium">{a.email}</div><div className="flex flex-wrap items-center gap-1 text-xs text-muted">{a.displayName || 'no sender name'}{a.groupName && <Badge color="blue">{a.groupName}</Badge>}{!a.usable && <Badge color="red">{a.status === 'REMOVED' ? 'removed' : (a.status || 'unavailable').toLowerCase()}</Badge>}</div></td>
              <td className="td">{a.total}</td>
              <td className="td">{k.SENT || 0}</td>
              <td className="td">{(k.PENDING || 0) + (k.SENDING || 0) + (k.ON_HOLD || 0)}</td>
              <td className="td">{(k.FAILED || 0)} / {(k.BOUNCED || 0)}</td>
              <td className="td w-48"><Meter kind="progress" value={done} max={a.total || 1} label={`${a.total ? Math.round((done / a.total) * 100) : 0}%`} /></td>
            </tr>
          );
        })}
      </Table>
      <p className="px-5 pb-4 text-xs text-muted">{c.type === 'FRESH'
        ? 'Recipients are split evenly between these accounts. If an account stops working or reaches its limit, its unsent emails move to the other accounts.'
        : 'Each follow-up goes from the same account that sent the first email, in the same thread. If that account is unavailable, the follow-up fails for that person — it is never sent from another account.'}</p>
    </Card>
  );
}

export default function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const act = useAction(id);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [modal, setModal] = useState(null);
  const [speed, setSpeed] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => get(`/api/campaigns/${id}`),
    staleTime: STALE.stats,
    refetchInterval: (q) => (q.state.data?.campaign?.status === 'SENDING' ? 20_000 : false),
  });
  const c = data?.campaign;
  const review = useQuery({ queryKey: ['review', id], queryFn: () => get(`/api/campaigns/${id}/review`), enabled: Boolean(c && ['DRAFT', 'PENDING_APPROVAL'].includes(c.status)) });
  const recips = useQuery({
    queryKey: ['recipients', id, { filter, search, page }],
    queryFn: () => get(`/api/campaigns/${id}/recipients${qs({ status: filter, search, page, pageSize: 25 })}`),
    staleTime: STALE.stats,
  });

  if (isLoading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const s = c.stats;
  const ids = [...selected];
  const bulk = async (path, body, ok) => { await act(() => post(`/api/campaigns/${id}/recipients/${path}`, { ids, ...body }), (r) => `${r.updated} ${ok}`); setSelected(new Set()); };
  const toggleAll = () => setSelected((sel) => (sel.size ? new Set() : new Set((recips.data?.items || []).map((r) => r.id))));
  const toggle = (rid) => setSelected((sel) => { const n = new Set(sel); if (n.has(rid)) n.delete(rid); else n.add(rid); return n; });

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={c.status} /> {c.type === 'FOLLOWUP' ? <>Follow-up of <Link className="text-brand-600 dark:text-brand-300" to={`/app/campaigns/${c.parent?.id}`}>{c.parent?.name}</Link></> : <>from {data.accounts?.length > 1 ? `${data.accounts.length} accounts` : c.account?.email}</>} · {c.hourlyRate}/hour{data.accounts?.length > 1 ? ' per account' : ''}</span>}
        actions={(
          <>
            {['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'PAUSED'].includes(c.status) && <Button variant="secondary" onClick={() => setModal('edit')}>Edit</Button>}
            {['DRAFT', 'PENDING_APPROVAL'].includes(c.status) && <Button variant="secondary" onClick={() => setModal('test')}>Send test</Button>}
            {c.status === 'DRAFT' && <Button variant="brand" onClick={() => setModal('start')}>Start / schedule</Button>}
            {['SENDING', 'SCHEDULED'].includes(c.status) && <Button variant="secondary" onClick={() => act(() => post(`/api/campaigns/${id}/pause`), 'Paused')}>Pause</Button>}
            {c.status === 'PAUSED' && !c.pausedByAdmin && <Button variant="brand" onClick={() => act(() => post(`/api/campaigns/${id}/resume`), 'Resumed')}>Resume</Button>}
            {['SENDING', 'PAUSED', 'COMPLETED', 'CANCELLED'].includes(c.status) && s.sent > 0 && <Button variant="secondary" onClick={() => setModal('followup')}>Create follow-up</Button>}
            {['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'SENDING', 'PAUSED'].includes(c.status) && <ConfirmButton variant="ghost" confirm="Cancel campaign?" onConfirm={() => act(() => post(`/api/campaigns/${id}/cancel`), 'Cancelled')}>Cancel</ConfirmButton>}
            {['COMPLETED', 'CANCELLED'].includes(c.status) && <Button variant="secondary" onClick={() => act(() => post(`/api/campaigns/${id}/archive`, { archived: !c.archived }), c.archived ? 'Restored' : 'Archived')}>{c.archived ? 'Unarchive' : 'Archive'}</Button>}
            {c.status !== 'SENDING' && s.sent + s.failed + s.bounced + s.unknown === 0 && <ConfirmButton variant="ghost" confirm="Delete campaign?" onConfirm={async () => { if (await act(() => del(`/api/campaigns/${id}`), 'Deleted')) navigate('/app/campaigns'); }}>Delete</ConfirmButton>}
          </>
        )}
      />

      {c.pausedReason && <div className="mb-4 rounded-2xl border bg-amber-500/12 px-4 py-2 text-sm text-amber-800 dark:text-amber-200">{c.pausedReason}</div>}
      {c.status === 'SCHEDULED' && <div className="mb-4 rounded-2xl border bg-brand-500/10 px-4 py-2 text-sm text-brand-800 dark:text-brand-200">Scheduled for {fmt.date(c.scheduledAt)}. If the server is asleep at that moment, sending starts as soon as it wakes.</div>}
      {c.status === 'SENDING' && c.scheduledAt && c.startedAt && new Date(c.startedAt) - new Date(c.scheduledAt) > 5 * 60_000 && (
        <div className="mb-4 rounded-2xl border bg-amber-500/12 px-4 py-2 text-sm text-amber-800 dark:text-amber-200">Started {Math.round((new Date(c.startedAt) - new Date(c.scheduledAt)) / 60_000)} min after the scheduled time because the worker was asleep or unavailable.</div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
        <Stat label="Recipients" value={s.total} />
        <Stat label="Pending" value={s.pending + s.sending} />
        <Stat label="SMTP accepted" value={s.sent} />
        <Stat label="Opened*" value={s.opened} hint={fmt.pct(s.opened, s.sent)} />
        <Stat label="Clicked*" value={s.clicked} hint={fmt.pct(s.clicked, s.sent)} />
        <Stat label="Replied" value={s.replied} hint={fmt.pct(s.replied, s.sent)} />
        <Stat label="Bounced / failed" value={`${s.bounced} / ${s.failed}`} tone={s.bounced + s.failed ? 'warn' : undefined} />
        <Stat label="Unsubscribed" value={s.unsubscribed} />
      </div>
      <div className="mt-3"><Meter kind="progress" label={`Completion ${s.completion}%`} value={s.total - s.pending - s.sending} max={s.total} /></div>
      <p className="mt-1 text-xs text-faint">* Opens/clicks are approximate: image blocking, Apple Mail Privacy Protection and link scanners distort them. "Delivered" is only known when the provider reports it; "SMTP accepted" means the sending server took the message.</p>

      {(s.unknown > 0 || s.onHold > 0) && (
        <div className="mt-4 space-y-2">
          {s.unknown > 0 && <div className="rounded-2xl border bg-violet-500/10 px-4 py-2 text-sm text-violet-700 dark:text-violet-300"><b>{s.unknown}</b> send(s) have an unknown outcome (the connection dropped after the message was handed to the server). Emails Pro checked the Sent folder where possible and will not resend automatically. <button type="button" className="underline" onClick={() => { setFilter('UNKNOWN'); setPage(1); }}>Review them</button>.</div>}
          {s.onHold > 0 && <div className="rounded-2xl border bg-amber-500/12 px-4 py-2 text-sm text-amber-800 dark:text-amber-200"><b>{s.onHold}</b> recipient(s) are on hold because their original sending account is unavailable. Reconnect it and release them, or skip them. <button type="button" className="underline" onClick={() => { setFilter('ON_HOLD'); setPage(1); }}>Review</button>.</div>}
        </div>
      )}

      <SendingAccounts c={c} accounts={data.accounts} onChange={() => setModal('accounts')} />

      {review.data && ['DRAFT', 'PENDING_APPROVAL'].includes(c.status) && (
        <Card title="Review before sending" className="mt-4">
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div><div className="label">Recipients</div>{review.data.stats.pending} ready{review.data.stats.suppressed ? ` · ${review.data.stats.suppressed} suppressed` : ''}</div>
            {review.data.estimate && <div><div className="label">Estimated duration</div>~{review.data.estimate.hours} sending hours · {review.data.estimate.days} day(s){review.data.estimate.warmupActive && ' (warm-up limits apply)'}</div>}
            <div><div className="label">Approval</div>{review.data.requireApproval ? (c.approvedAt ? <Badge color="green">approved</Badge> : <Badge color="purple">admin approval required</Badge>) : 'Not required'}</div>
          </div>
          {review.data.checks.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-fg2">{review.data.checks.map((ch) => <li key={ch.message}>{ch.message}</li>)}</ul>}
          {c.type === 'FRESH' && (
            <div className="mt-3 flex items-end gap-2">
              <Field label="Change speed (emails/hour)"><input className="input w-32" type="number" min="1" value={speed} placeholder={c.hourlyRate} onChange={(e) => setSpeed(e.target.value)} /></Field>
              <Button variant="secondary" disabled={!speed} onClick={() => act(() => patch(`/api/campaigns/${id}`, { hourlyRate: Number(speed) }), 'Speed updated')}>Save</Button>
            </div>
          )}
        </Card>
      )}

      <Card className="mt-4" padded={false} title="Recipients" actions={(
        <>
          <input className="input w-48" placeholder="Search email" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          <select className="input w-40" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1); setSelected(new Set()); }}>{FILTERS.map((x) => <option key={x} value={x}>{x ? x.replace('_', ' ').toLowerCase() : 'all statuses'}</option>)}</select>
          {['FAILED', 'BOUNCED', 'UNKNOWN'].includes(filter) && <Button size="sm" variant="secondary" onClick={() => download(`/api/campaigns/${id}/recipients/export?status=${filter}`, `${c.name}-${filter.toLowerCase()}.csv`).catch(toast.error)}>Export CSV</Button>}
        </>
      )}>
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle px-3 py-2 text-sm">
            <span>{selected.size} selected</span>
            {filter === 'PENDING' && <Button size="sm" variant="secondary" onClick={() => bulk('remove', {}, 'removed')}>Remove from campaign</Button>}
            {filter === 'ON_HOLD' && <><Button size="sm" onClick={() => bulk('hold', { action: 'release' }, 'released')}>Release (account reconnected)</Button><Button size="sm" variant="secondary" onClick={() => bulk('hold', { action: 'skip' }, 'skipped')}>Skip</Button></>}
            {filter === 'UNKNOWN' && <><Button size="sm" onClick={() => bulk('unknown', { action: 'mark_sent' }, 'marked sent')}>Mark as sent</Button><Button size="sm" variant="secondary" onClick={() => bulk('unknown', { action: 'mark_failed' }, 'marked failed')}>Mark failed</Button><ConfirmButton size="sm" variant="secondary" confirm="May send a duplicate. Continue?" onConfirm={() => bulk('unknown', { action: 'retry' }, 'queued for retry')}>Retry anyway</ConfirmButton></>}
            {filter === 'FAILED' && <Button size="sm" onClick={() => bulk('retry-failed', {}, 'queued (only temporary failures are eligible)')}>Retry eligible</Button>}
          </div>
        )}
        <Table head={[<input key="all" type="checkbox" checked={selected.size > 0} onChange={toggleAll} aria-label="Select all" />, 'Email', 'Status', 'Sender', 'Sent', 'Engagement', 'Details']}
          empty={recips.data && !recips.data.items.length && <div className="p-6 text-center text-sm text-muted">No recipients match.</div>}>
          {(recips.data?.items || []).map((r) => (
            <tr key={r.id}>
              <td className="td"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.email}`} /></td>
              <td className="td"><div>{r.email}</div><div className="text-xs text-faint">{[r.vars?.firstName, r.vars?.company].filter(Boolean).join(' · ')}</div></td>
              <td className="td"><StatusBadge status={r.status} />{r.holdReason === 'ORIGINAL_ACCOUNT_UNAVAILABLE' && <div className="text-xs text-amber-700 dark:text-amber-300">original sender unavailable</div>}{r.holdReason === 'RECONCILE_NOT_FOUND' && <div className="text-xs text-violet-700 dark:text-violet-300">not found in Sent folder</div>}</td>
              <td className="td text-xs">{r.account?.email || '—'}</td>
              <td className="td text-xs">{fmt.date(r.sentAt)}</td>
              <td className="td text-xs space-x-1">{r.openedAt && <Badge color="blue">opened</Badge>}{r.clickedAt && <Badge color="blue">clicked</Badge>}{!r.clickedAt && r.clickCount > 0 && <Badge title="Clicked within seconds of delivery — likely a link scanner">scanner?</Badge>}{r.repliedAt && <Badge color="green">replied</Badge>}{r.unsubscribedAt && <Badge color="red">unsubscribed</Badge>}</td>
              <td className="td max-w-sm text-xs text-muted">{r.lastError}{r.status === 'PENDING' && r.attempts > 0 && <div>retry #{r.attempts} at {fmt.date(r.nextAttemptAt)}</div>}</td>
            </tr>
          ))}
        </Table>
        {recips.data && <Pagination page={page} pageSize={25} total={recips.data.total} onPage={setPage} />}
      </Card>

      {c.followUps?.length > 0 && (
        <Card title="Follow-ups" className="mt-4">
          <ul className="space-y-1 text-sm">{c.followUps.map((fu) => <li key={fu.id}><Link className="text-brand-600 dark:text-brand-300" to={`/app/campaigns/${fu.id}`}>{fu.name}</Link> <StatusBadge status={fu.status} /></li>)}</ul>
        </Card>
      )}

      <Card title="Email content" className="mt-4">
        <EmailPreview subject={c.subject} html={c.html} height={420} from={data.accounts?.[0] ? { name: data.accounts[0].displayName || data.accounts[0].email, email: data.accounts[0].email } : undefined} />
      </Card>

      {modal === 'start' && <StartModal open onClose={() => setModal(null)} campaign={c} review={review.data} />}
      {modal === 'followup' && <FollowUpModal open onClose={() => setModal(null)} campaign={c} />}
      {modal === 'test' && <TestModal open onClose={() => setModal(null)} campaign={c} />}
      {modal === 'edit' && <EditCampaign campaign={c} onClose={() => setModal(null)} />}
      {modal === 'accounts' && <ChangeAccounts campaign={c} current={c.accountIds || []} onClose={() => setModal(null)} />}
    </>
  );
}