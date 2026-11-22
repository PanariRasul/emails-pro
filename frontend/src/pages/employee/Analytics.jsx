import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { get } from '../../api/client.js';
import { STALE } from '../../lib/query.js';
import { Button, Card, ErrorBox, Loading, PageHeader, Table, fmt } from '../../components/ui.jsx';

export default function Analytics() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useQuery({ queryKey: ['analytics', days], queryFn: () => get(`/api/reports/analytics?days=${days}`), staleTime: STALE.stats });
  return (
    <>
      <PageHeader title="Analytics" subtitle={data?.note} actions={[7, 30, 90].map((d) => <Button key={d} size="sm" variant={days === d ? 'primary' : 'secondary'} onClick={() => setDays(d)}>{d} days</Button>)} />
      {data?.tracking && !data.tracking.reachable && <div className="mb-4 rounded-2xl border bg-brand-500/10 px-4 py-3 text-sm text-brand-800 dark:text-brand-200"><b>Opens and clicks can't be counted yet:</b> tracking links point to {data.tracking.url}, which recipients can't reach. They work once the app is deployed on its public address.</div>}
      {error && !data && <ErrorBox error={error} />}
      {isLoading && !data ? <Loading /> : data && (
        <div className="space-y-4">
          <Card title="Daily activity">
            <div className="h-72">
              <ResponsiveContainer>
                <LineChart data={data.daily}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="day" fontSize={11} />
                  <YAxis fontSize={11} allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Line dataKey="sent" stroke="#0f172a" dot={false} />
                  <Line dataKey="opened" stroke="#0ea5e9" dot={false} />
                  <Line dataKey="replied" stroke="#10b981" dot={false} />
                  <Line dataKey="bounced" stroke="#ef4444" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="By sending account" padded={false}>
            <div className="h-60 p-4">
              <ResponsiveContainer>
                <BarChart data={data.byAccount}><XAxis dataKey="email" fontSize={10} /><YAxis fontSize={11} /><Tooltip /><Bar dataKey="sent" fill="#0f172a" /><Bar dataKey="replied" fill="#10b981" /><Bar dataKey="bounced" fill="#ef4444" /></BarChart>
              </ResponsiveContainer>
            </div>
            <Table head={['Account', 'Sent', 'Replied', 'Reply rate', 'Bounced', 'Bounce rate']}>
              {data.byAccount.map((a) => (
                <tr key={a.email}><td className="td">{a.email}</td><td className="td">{a.sent}</td><td className="td">{a.replied}</td><td className="td">{fmt.pct(a.replied, a.sent)}</td><td className="td">{a.bounced}</td><td className="td">{fmt.pct(a.bounced, a.sent)}</td></tr>
              ))}
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}