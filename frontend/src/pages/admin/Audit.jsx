import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../../api/client.js';
import { Card, ErrorBox, Loading, PageHeader, Pagination, Table, fmt } from '../../components/ui.jsx';

export default function Audit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'audit', { page, action }], queryFn: () => get(`/api/admin/audit${qs({ page, pageSize: 50, action })}`) });
  return (
    <>
      <PageHeader title="Audit logs" subtitle="Account, policy, permission and campaign changes"
        actions={<select className="input w-48" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
          <option value="">All actions</option>{['auth', 'employee', 'account', 'campaign', 'settings', 'emergency', 'suppression', 'pitch'].map((a) => <option key={a} value={a}>{a}.*</option>)}
        </select>} />
      {error && <ErrorBox error={error} />}
      {isLoading && !data ? <Loading /> : (
        <Card padded={false}>
          <Table head={['Time', 'Actor', 'Action', 'Target', 'Details', 'IP']}>
            {(data?.items || []).map((a) => (
              <tr key={a.id}>
                <td className="td text-xs">{fmt.date(a.createdAt)}</td>
                <td className="td text-sm">{a.actor?.name || '—'}<div className="text-xs text-faint">{a.actor?.email}</div></td>
                <td className="td font-mono text-xs">{a.action}</td>
                <td className="td text-xs">{a.entityType} {a.entityId?.slice(0, 10)}</td>
                <td className="td max-w-sm break-words font-mono text-[11px] text-muted">{a.meta ? JSON.stringify(a.meta).slice(0, 200) : ''}</td>
                <td className="td text-xs">{a.ip}</td>
              </tr>
            ))}
          </Table>
          {data && <Pagination page={page} pageSize={50} total={data.total} onPage={setPage} />}
        </Card>
      )}
    </>
  );
}
