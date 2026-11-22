import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client.js';
import { STALE } from '../../lib/query.js';
import { Badge, Card, ErrorBox, Loading, PageHeader, StatusBadge, Table, fmt } from '../../components/ui.jsx';

export default function Deliverability() {
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'deliverability'], queryFn: () => get('/api/admin/deliverability'), staleTime: STALE.admin });
  return (
    <>
      <PageHeader title="Deliverability" subtitle="Last 30 days per sending account. Good deliverability comes from authentication, permission-based lists and sensible pacing — inbox placement is never guaranteed." />
      {error && <ErrorBox error={error} />}
      {isLoading && !data ? <Loading /> : (
        <Card padded={false}>
          <Table head={['Account', 'Employee', 'Status', 'SPF', 'DMARC', 'Sent', 'Bounce rate', 'Replies', 'Unsubscribes', 'Auth failures', 'Throttled']}>
            {(data?.accounts || []).map((a) => (
              <tr key={a.id}>
                <td className="td">{a.email}<div className="text-xs text-muted">{a.provider.toLowerCase()}</div></td>
                <td className="td text-sm">{a.owner}</td>
                <td className="td"><StatusBadge status={a.status} /></td>
                <td className="td">{a.dnsSpf ? <Badge color="green">ok</Badge> : <Badge color="yellow">missing</Badge>}</td>
                <td className="td">{a.dnsDmarc ? <Badge color="green">ok</Badge> : <Badge color="yellow">missing</Badge>}</td>
                <td className="td">{a.sent}</td>
                <td className="td"><span className={a.bounceRate > 0.05 ? 'font-semibold text-red-600 dark:text-red-400' : ''}>{(a.bounceRate * 100).toFixed(1)}%</span></td>
                <td className="td">{a.replied} <span className="text-xs text-faint">{fmt.pct(a.replied, a.sent)}</span></td>
                <td className="td">{a.unsubscribed}</td>
                <td className="td">{a.authFailures}</td>
                <td className="td">{a.throttled}</td>
              </tr>
            ))}
          </Table>
          <p className="border-t border-line px-3 py-2 text-xs text-muted">{data?.note}</p>
        </Card>
      )}
    </>
  );
}
