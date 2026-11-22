import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get, post, qs } from '../../api/client.js';
import { STALE, invalidate } from '../../lib/query.js';
import { Badge, Button, Card, ErrorBox, Field, Loading, Meter, Modal, PageHeader, Pagination, StatusBadge, Table, fmt, toast } from '../../components/ui.jsx';

export default function AdminCampaigns() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get('status') || '');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState(null);
  const [reason, setReason] = useState({ id: null, kind: null, text: '' });
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'campaigns', { status, page }], queryFn: () => get(`/api/admin/campaigns${qs({ status, page, pageSize: 25 })}`), staleTime: STALE.admin });
  const detail = useQuery({ queryKey: ['admin', 'campaign', viewing], queryFn: () => get(`/api/admin/campaigns/${viewing}`), enabled: Boolean(viewing) });
  const act = async (path, body, msg) => { try { await post(`/api/admin/campaigns/${path}`, body); invalidate('admin'); toast.ok(msg); setReason({ id: null, kind: null, text: '' }); } catch (err) { toast.error(err); } };
  return (
    <>
      <PageHeader title="Campaign monitoring" subtitle="View, approve and pause employee campaigns. Administrators cannot create or send campaigns." />
      <Card padded={false} title="Campaigns" actions={<select className="input w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{['PENDING_APPROVAL', 'SCHEDULED', 'SENDING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'DRAFT'].map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}</select>}>
        {error && <ErrorBox error={error} />}
        {isLoading && !data ? <Loading /> : (
          <Table head={['Campaign', 'Employee', 'Status', 'Progress', 'Sent', 'Replied', 'Bounced', '']}>
            {(data?.items || []).map((c) => (
              <tr key={c.id}>
                <td className="td"><button type="button" className="text-left font-medium text-brand-700 dark:text-brand-300 hover:underline" onClick={() => setViewing(c.id)}>{c.name}</button><div className="text-xs text-muted">{c.accountIds?.length > 1 ? `${c.accountIds.length} accounts (${c.account?.email} …)` : (c.account?.email || 'original senders')} · {c.hourlyRate}/h</div></td>
                <td className="td text-sm">{c.owner.name}</td>
                <td className="td"><StatusBadge status={c.status} />{c.pausedByAdmin && <Badge color="red">admin hold</Badge>}</td>
                <td className="td w-36"><Meter kind="progress" label={`${c.stats.completion}%`} value={c.stats.total - c.stats.pending - c.stats.sending} max={c.stats.total} /></td>
                <td className="td">{c.stats.sent}</td>
                <td className="td">{c.stats.replied}</td>
                <td className="td">{c.stats.bounced}</td>
                <td className="td"><div className="flex flex-wrap justify-end gap-1">
                  {c.status === 'PENDING_APPROVAL' && <><Button size="sm" variant="brand" onClick={() => act(`${c.id}/approve`, {}, 'Approved — the employee can now start it')}>Approve</Button><Button size="sm" variant="secondary" onClick={() => setReason({ id: c.id, kind: 'reject', text: '' })}>Decline</Button></>}
                  {['SENDING', 'SCHEDULED', 'PAUSED', 'PENDING_APPROVAL'].includes(c.status) && !c.pausedByAdmin && <Button size="sm" variant="danger" onClick={() => setReason({ id: c.id, kind: 'pause', text: '' })}>Pause</Button>}
                  {c.pausedByAdmin && <Button size="sm" variant="secondary" onClick={() => act(`${c.id}/release`, {}, 'Hold released — employee may resume')}>Release hold</Button>}
                </div></td>
              </tr>
            ))}
          </Table>
        )}
        {data && <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />}
      </Card>
      <Modal open={Boolean(reason.id)} onClose={() => setReason({ id: null })} title={reason.kind === 'pause' ? 'Pause campaign' : 'Decline campaign'}
        footer={<Button variant="danger" onClick={() => act(`${reason.id}/${reason.kind}`, { reason: reason.text || undefined }, reason.kind === 'pause' ? 'Campaign paused' : 'Campaign declined')}>{reason.kind === 'pause' ? 'Pause' : 'Decline'}</Button>}>
        <Field label="Reason (shown to the employee)"><input className="input" value={reason.text} onChange={(e) => setReason({ ...reason, text: e.target.value })} /></Field>
      </Modal>
      <Modal open={Boolean(viewing)} onClose={() => setViewing(null)} wide title={detail.data?.campaign.name || 'Campaign'}>
        {!detail.data ? <Loading /> : (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div><span className="label">Employee</span>{detail.data.campaign.owner.name}</div>
              <div><span className="label">Status</span><StatusBadge status={detail.data.campaign.status} /></div>
              <div><span className="label">Started</span>{fmt.date(detail.data.campaign.startedAt)}</div>
              <div><span className="label">Recipients</span>{detail.data.campaign.stats.total}</div>
            </div>
            <div><span className="label">Subject</span>{detail.data.campaign.subject}</div>
            <iframe title="content" sandbox="" className="h-72 w-full rounded border" srcDoc={detail.data.campaign.html} />
          </div>
        )}
      </Modal>
    </>
  );
}