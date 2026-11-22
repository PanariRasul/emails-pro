import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { get } from '../../api/client.js';
import { STALE } from '../../lib/query.js';
import { Button, Card, ErrorBox, Loading, PageHeader, Table, fmt } from '../../components/ui.jsx';

export default function Reports() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useQuery({ queryKey: ['admin', 'reports', days], queryFn: () => get(`/api/admin/reports?days=${days}`), staleTime: STALE.admin });
  return (
    <>
      <PageHeader title="Reports" subtitle="System-wide and per-employee sending analytics" actions={[7, 30, 90].map((d) => <Button key={d} size="sm" variant={days === d ? 'primary' : 'secondary'} onClick={() => setDays(d)}>{d} days</Button>)} />
      {error && <ErrorBox error={error} />}
      {isLoading && !data ? <Loading /> : data && (
        <div className="space-y-4">
          <Card title="Daily volume">
            <div className="h-64"><ResponsiveContainer><BarChart data={data.daily}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" /><XAxis dataKey="day" fontSize={11} /><YAxis fontSize={11} /><Tooltip /><Legend /><Bar dataKey="sent" fill="#0f172a" /><Bar dataKey="replied" fill="#10b981" /><Bar dataKey="bounced" fill="#ef4444" /></BarChart></ResponsiveContainer></div>
          </Card>
          <Card title="By employee" padded={false}>
            <Table head={['Employee', 'Sent', 'Opened*', 'Clicked*', 'Replied', 'Reply rate', 'Bounced', 'Failed']}>
              {data.perEmployee.map((e) => (
                <tr key={e.id}><td className="td">{e.name}<div className="text-xs text-muted">{e.email}</div></td><td className="td">{e.sent}</td><td className="td">{e.opened}</td><td className="td">{e.clicked}</td><td className="td">{e.replied}</td><td className="td">{fmt.pct(e.replied, e.sent)}</td><td className="td">{e.bounced}</td><td className="td">{e.failed}</td></tr>
              ))}
            </Table>
            <p className="px-3 py-2 text-xs text-faint">* Approximate — not proof of human engagement.</p>
          </Card>
        </div>
      )}
    </>
  );
}
