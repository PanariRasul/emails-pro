import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, UserPlus, Users } from 'lucide-react';
import { del, get, patch, post, qs } from '../../api/client.js';
import { STALE, invalidate } from '../../lib/query.js';
import { Button, Card, ConfirmButton, ErrorBox, Field, Loading, Modal, PageHeader, Pagination, Table, cx, fmt, toast } from '../../components/ui.jsx';
import ContactsInput, { SampleLinks, uploadContacts } from '../../components/ContactsInput.jsx';

function AddContactsModal({ list, onClose }) {
  const [contacts, setContacts] = useState([]);
  const [consent, setConsent] = useState(list.source || '');
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const upload = async () => {
    setError(null);
    setProgress({ done: 0, total: contacts.length });
    try {
      const t = await uploadContacts(list.id, contacts, { consentSource: consent, onProgress: (done, total) => setProgress({ done, total }) });
      invalidate('lists', ['contacts', list.id]);
      toast.ok(`Added ${t.added} contacts${t.duplicates ? ` · ${t.duplicates} already in the list` : ''}${t.suppressed ? ` · ${t.suppressed} unsubscribed/bounced (won't be emailed)` : ''}`);
      onClose();
    } catch (err) { setError(err); setProgress(null); }
  };

  return (
    <Modal open onClose={onClose} size="xl" title={`Add contacts to “${list.name}”`}
      footer={<>
        {progress && <span className="mr-auto self-center text-xs text-muted">Saving {progress.done} / {progress.total}…</span>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="brand" disabled={!contacts.length || Boolean(progress)} loading={Boolean(progress)} onClick={upload}>Add {contacts.length || ''} contact{contacts.length === 1 ? '' : 's'}</Button>
      </>}>
      <div className="space-y-4">
        <ContactsInput onChange={setContacts} />
        <Field label="Where are these contacts from?" hint="Saved with each contact as the consent / source record, e.g. “Trade show 2026”, “Website enquiries”.">
          <input className="input" value={consent} onChange={(e) => setConsent(e.target.value)} placeholder="e.g. Existing customers" />
        </Field>
        <p className="text-xs text-muted">Only add people who agreed to hear from you or with whom you have a business relationship. Unsubscribed and bounced addresses are never emailed.</p>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function EditContact({ list, contact, onClose }) {
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (contact) { setF({ firstName: contact.firstName || '', lastName: contact.lastName || '', company: contact.company || '' }); setError(null); } }, [contact]);
  const save = async () => {
    setBusy(true); setError(null);
    try { await patch(`/api/lists/${list.id}/contacts/${contact.id}`, { firstName: f.firstName || null, lastName: f.lastName || null, company: f.company || null }); invalidate(['contacts', list.id]); toast.ok('Contact saved'); onClose(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={Boolean(contact)} onClose={onClose} title={contact?.email || ''} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} loading={busy}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name"><input className="input" value={f.firstName || ''} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
        <Field label="Last name"><input className="input" value={f.lastName || ''} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Company"><input className="input" value={f.company || ''} onChange={(e) => setF({ ...f, company: e.target.value })} /></Field></div>
      </div>
      {contact?.fields && <p className="mt-3 text-xs text-muted">Other fields: {Object.entries(contact.fields).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>}
      <p className="mt-2 text-xs text-muted">Changes apply to campaigns created from now on.</p>
      <ErrorBox error={error} />
    </Modal>
  );
}

function RenameList({ list, onClose }) {
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  useEffect(() => { if (list) { setName(list.name); setSource(list.source || ''); } }, [list]);
  const save = async () => { try { await patch(`/api/lists/${list.id}`, { name: name.trim(), source: source.trim() || null }); invalidate('lists'); toast.ok('List updated'); onClose(); } catch (err) { toast.error(err); } };
  return (
    <Modal open={Boolean(list)} onClose={onClose} title="Edit list" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={save} disabled={!name.trim()}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="List name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Source / consent note" hint="Recorded for contacts added from now on."><input className="input" value={source} onChange={(e) => setSource(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export default function Lists() {
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => get('/api/lists'), staleTime: STALE.lists });
  const [activeId, setActiveId] = useState(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [importing, setImporting] = useState(null);
  const [editingContact, setEditingContact] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [checked, setChecked] = useState(() => new Set());
  const active = (lists.data?.lists || []).find((l) => l.id === activeId) || lists.data?.lists?.[0];
  const contacts = useQuery({
    queryKey: ['contacts', active?.id, { page, search }],
    queryFn: () => get(`/api/lists/${active.id}/contacts${qs({ page, pageSize: 25, search })}`),
    enabled: Boolean(active),
    staleTime: STALE.lists,
  });
  const create = async () => {
    try { const r = await post('/api/lists', { name: newName.trim() }); setNewName(''); invalidate('lists'); setActiveId(r.list.id); setImporting({ ...r.list, contacts: 0 }); } catch (err) { toast.error(err); }
  };
  const removeList = async () => { try { await del(`/api/lists/${active.id}`); setActiveId(null); invalidate('lists'); toast.ok('List deleted (campaign history is unaffected)'); } catch (err) { toast.error(err); } };
  const removeChecked = async () => {
    try { const r = await post(`/api/lists/${active.id}/contacts/delete`, { ids: [...checked] }); setChecked(new Set()); invalidate(['contacts', active.id], 'lists'); toast.ok(`Deleted ${r.deleted} contact(s)`); } catch (err) { toast.error(err); }
  };
  const removeContact = async (c) => { try { await del(`/api/lists/${active.id}/contacts/${c.id}`); invalidate(['contacts', active.id], 'lists'); } catch (err) { toast.error(err); } };

  if (lists.isLoading && !lists.data) return <Loading />;
  return (
    <>
      <PageHeader title="Recipients" subtitle="Paste emails or upload Excel / CSV — names and companies are filled in for you"
        actions={active && <Button variant="brand" icon={UserPlus} onClick={() => setImporting(active)}>Add contacts</Button>} />
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card title="Lists" padded={false}>
          <ul className="divide-y divide-line">
            {(lists.data?.lists || []).map((l) => (
              <li key={l.id}><button type="button" onClick={() => { setActiveId(l.id); setPage(1); setChecked(new Set()); }} className={cx('flex w-full justify-between px-4 py-2 text-left text-sm hover:bg-subtle', active?.id === l.id && 'bg-subtle font-medium')}><span className="truncate">{l.name}</span><span className="text-xs text-muted">{l.contacts}</span></button></li>
            ))}
          </ul>
          <div className="flex gap-2 border-t border-line p-3">
            <input className="input" placeholder="New list name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && newName.trim() && create()} />
            <Button size="sm" icon={Plus} disabled={!newName.trim()} onClick={create}>Create</Button>
          </div>
        </Card>
        {active ? (
          <Card title={`${active.name} · ${active.contacts} contacts`} padded={false} actions={(
            <>
              <input className="input w-48" placeholder="Search" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
              {checked.size > 0 && <ConfirmButton size="sm" variant="danger" confirm={`Delete ${checked.size}?`} onConfirm={removeChecked}><Trash2 className="mr-1 inline h-3.5 w-3.5" />Delete {checked.size}</ConfirmButton>}
              <Button size="sm" variant="secondary" icon={UserPlus} onClick={() => setImporting(active)}>Add contacts</Button>
              <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRenaming(active)}>Edit list</Button>
              <ConfirmButton size="sm" variant="ghost" confirm="Delete list?" onConfirm={removeList}>Delete list</ConfirmButton>
            </>
          )}>
            <Table head={[<input key="all" type="checkbox" aria-label="Select all" checked={Boolean(contacts.data?.items.length) && contacts.data.items.every((c) => checked.has(c.id))} onChange={(e) => setChecked(e.target.checked ? new Set(contacts.data.items.map((c) => c.id)) : new Set())} />, 'Email', 'Name', 'Company', 'Custom fields', 'Source', 'Added', '']} empty={contacts.data && !contacts.data.items.length && (search ? <div className="p-8 text-center text-sm text-muted">No contacts match “{search}”.</div> : (
              <div className="flex flex-col items-center gap-3 p-10 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/10 text-brand-600 dark:text-brand-300"><Users className="h-6 w-6" /></span>
                <div className="text-sm font-medium text-fg">This list is empty</div>
                <div className="max-w-sm text-xs text-muted">Paste email addresses (one per line) or upload an Excel / CSV file. Names and companies are filled in from the addresses.</div>
                <Button variant="brand" icon={UserPlus} onClick={() => setImporting(active)}>Add contacts</Button>
                <SampleLinks className="justify-center" />
              </div>
            ))}>
              {(contacts.data?.items || []).map((c) => (
                <tr key={c.id}>
                  <td className="td w-8"><input type="checkbox" checked={checked.has(c.id)} aria-label={`Select ${c.email}`} onChange={() => setChecked((s) => { const n = new Set(s); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} /></td>
                  <td className="td">{c.email}</td>
                  <td className="td">{[c.firstName, c.lastName].filter(Boolean).join(' ')}</td>
                  <td className="td">{c.company}</td>
                  <td className="td text-xs text-muted">{c.fields ? Object.keys(c.fields).join(', ') : ''}</td>
                  <td className="td text-xs">{c.consentSource}</td>
                  <td className="td text-xs">{fmt.date(c.createdAt)}</td>
                  <td className="td"><div className="flex justify-end gap-1"><Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditingContact(c)}>Edit</Button><ConfirmButton size="sm" variant="ghost" confirm="Delete?" onConfirm={() => removeContact(c)}>Delete</ConfirmButton></div></td>
                </tr>
              ))}
            </Table>
            {contacts.data && <Pagination page={page} pageSize={25} total={contacts.data.total} onPage={setPage} />}
          </Card>
        ) : (
          <Card>
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/10 text-brand-600 dark:text-brand-300"><Users className="h-6 w-6" /></span>
              <div className="text-sm font-medium text-fg">Create your first list</div>
              <div className="max-w-sm text-xs text-muted">Type a name in “New list name” (for example “Pune manufacturers”) and press Create — you can paste emails straight away.</div>
              <SampleLinks className="justify-center" />
            </div>
          </Card>
        )}
      </div>
      {importing && <AddContactsModal list={importing} onClose={() => setImporting(null)} />}
      <EditContact list={active} contact={editingContact} onClose={() => setEditingContact(null)} />
      <RenameList list={renaming} onClose={() => setRenaming(null)} />
      {lists.error && <ErrorBox error={lists.error} />}
    </>
  );
}