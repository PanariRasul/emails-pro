import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../../api/client.js';
import { STALE } from '../../lib/query.js';
import { Card, ErrorBox, Loading, PageHeader, Pagination, StatusBadge, Table, fmt } from '../../components/ui.jsx';

export default function History() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['history', { page, status }], queryFn: () => get(`/api/reports/history${qs({ page, pageSize: 50, status })}`), staleTime: STALE.stats });
  return (
    <>
      <PageHeader title="Sending history" subtitle="Every send attempt: which account sent it, when, and the SMTP server's response"
        actions={<select className="input w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All attempts</option><option value="ACCEPTED">Accepted</option><option value="FAILED">Failed</option><option value="UNKNOWN">Unknown</option></select>} />
      {error && !data && <ErrorBox error={error} />}
      {isLoading && !data ? <Loading /> : (
        <Card padded={false}>
          <Table head={['Time', 'Recipient', 'Campaign', 'Account', 'Attempt', 'Result', 'SMTP response']}>
            {(data?.items || []).map((a) => (
              <tr key={a.id}>
                <td className="td text-xs">{fmt.date(a.startedAt)}</td>
                <td className="td">{a.recipient?.email}</td>
                <td className="td text-xs">{a.campaignName}</td>
                <td className="td text-xs">{a.accountEmail}</td>
                <td className="td">#{a.attemptNo}</td>
                <td className="td"><StatusBadge status={a.status} />{a.errorClass && <div className="text-xs text-muted">{a.errorClass.toLowerCase()}</div>}</td>
                <td className="td max-w-md break-words text-xs text-muted">{a.smtpCode ? `${a.smtpCode} ` : ''}{a.response}</td>
              </tr>
            ))}
          </Table>
          {data && <Pagination page={page} pageSize={50} total={data.total} onPage={setPage} />}
        </Card>
      )}
    </>
  );
}
