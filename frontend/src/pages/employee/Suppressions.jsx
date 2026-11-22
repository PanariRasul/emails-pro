import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { del, get, post, qs } from '../../api/client.js';
import { invalidate } from '../../lib/query.js';
import { Badge, Button, Card, ErrorBox, Field, Loading, PageHeader, Pagination, Table, fmt, toast } from '../../components/ui.jsx';

const REASON = { UNSUBSCRIBE: 'red', HARD_BOUNCE: 'red', COMPLAINT: 'red', INVALID: 'yellow', MANUAL: 'gray' };

export default function Suppressions() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [emails, setEmails] = useState('');
  const { data, isLoading, error } = useQuery({ queryKey: ['suppressions', { page, search }], queryFn: () => get(`/api/suppressions${qs({ page, pageSize: 25, search })}`) });
  const add = async () => {
    try {
      const r = await post('/api/suppressions', { emails: emails.split(/[\s,;]+/).filter(Boolean) });
      setEmails(''); invalidate('suppressions'); toast.ok(`${r.added} address(es) suppressed`);
    } catch (err) { toast.error(err); }
  };
  const remove = async (s) => { try { await del(`/api/suppressions/${s.id}`); invalidate('suppressions'); } catch (err) { toast.error(err); } };
  return (
    <>
      <PageHeader title="Suppression list" subtitle="Addresses that will never be emailed. Unsubscribes, hard bounces and complaints are permanent and apply organisation-wide." />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card padded={false} actions={<input className="input w-56" placeholder="Search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />} title="Suppressed addresses">
          {error && <ErrorBox error={error} />}
          {isLoading && !data ? <Loading /> : (
            <Table head={['Email', 'Reason', 'Source', 'Date', '']}>
              {(data?.items || []).map((s) => (
                <tr key={s.id}>
                  <td className="td">{s.email}</td>
                  <td className="td"><Badge color={REASON[s.reason]}>{s.reason.replace('_', ' ').toLowerCase()}</Badge>{!s.manual && <span className="ml-1 text-xs text-faint">org-wide</span>}</td>
                  <td className="td text-xs">{s.source}</td>
                  <td className="td text-xs">{fmt.date(s.createdAt)}</td>
                  <td className="td">{s.manual && <Button size="sm" variant="ghost" onClick={() => remove(s)}>Remove</Button>}</td>
                </tr>
              ))}
            </Table>
          )}
          {data && <Pagination page={page} pageSize={25} total={data.total} onPage={setPage} />}
        </Card>
        <Card title="Add manually">
          <Field label="Email addresses" hint="Separate with commas, spaces or new lines"><textarea className="input h-32" value={emails} onChange={(e) => setEmails(e.target.value)} /></Field>
          <Button className="mt-3" disabled={!emails.trim()} onClick={add}>Suppress</Button>
        </Card>
      </div>
    </>
  );
}
