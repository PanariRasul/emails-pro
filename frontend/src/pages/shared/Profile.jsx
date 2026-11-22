import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, Briefcase, Calendar, Crown, Mail, Pencil, Phone, User } from 'lucide-react';
import { get, patch, qs } from '../../api/client.js';
import { useAuth } from '../../store/auth.js';
import { invalidate } from '../../lib/query.js';
import { Avatar, Badge, Button, Card, ErrorBox, Field, Meter, Modal, PageHeader, fmt, toast } from '../../components/ui.jsx';
import { SecurityPanel } from '../../components/SettingsKit.jsx';

function InfoTile({ icon: I, label, value }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-subtle p-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-card text-fg2"><I className="h-4 w-4" /></span>
      <span className="min-w-0"><span className="block text-xs text-muted">{label}</span><span className="block truncate text-[15px] font-medium">{value || '—'}</span></span>
    </div>
  );
}

function EditProfile({ open, onClose, user }) {
  const setUser = useAuth((s) => s.setUser);
  const [f, setF] = useState({ name: user.name, phone: user.phone || '', title: user.title || '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try { const r = await patch('/api/auth/me', { name: f.name, phone: f.phone || null, title: f.title || null }); setUser(r.user); toast.ok('Profile updated'); onClose(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title="Edit profile" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="space-y-4">
        <Field label="Full name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Job title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Account Executive" /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+91 …" /></Field>
        <p className="text-xs text-muted">Your sign-in email can only be changed by an administrator.</p>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

function TeamCard() {
  const { data } = useQuery({ queryKey: ['admin', 'employees', { page: 1, search: '' }], queryFn: () => get(`/api/admin/employees${qs({ page: 1, pageSize: 6 })}`) });
  return (
    <Card title="Team" actions={<Link to="/admin/employees?new=1"><Button size="sm" variant="secondary">+ Invite</Button></Link>}>
      <ul className="space-y-1">
        {(data?.items || []).map((u) => (
          <li key={u.id}><Link to={`/admin/employees/${u.id}`} className="flex items-center gap-3 rounded-2xl p-2.5 hover:bg-subtle">
            <Avatar name={u.name} /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{u.name}</span><span className="block truncate text-xs text-muted">{u.email} · {u.sentToday} sent today</span></span>
            {!u.isActive ? <Badge color="red">Inactive</Badge> : u.sendingDisabled ? <Badge color="yellow">Sending off</Badge> : <Badge color="green">Active</Badge>}
          </Link></li>
        ))}
        {data && !data.items.length && <li className="py-6 text-center text-sm text-muted">No employees yet.</li>}
      </ul>
    </Card>
  );
}

function QuotaCard() {
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: () => get('/api/reports/dashboard'), staleTime: 45_000 });
  if (!data) return <Card title="Your quotas"><div className="h-32" /></Card>;
  return (
    <Card title="Your quotas" subtitle="Today (UTC)">
      <div className="space-y-5">
        <Meter label="Emails sent today" value={data.quota.sentToday} max={data.quota.dailyLimit} />
        <Meter label="Email accounts" value={data.accounts.total} max={data.accounts.limit} />
        <Meter label="Working campaigns" value={data.campaigns.working} max={data.campaigns.limit} />
      </div>
    </Card>
  );
}

export default function Profile() {
  const user = useAuth((s) => s.user);
  const me = useQuery({ queryKey: ['me'], queryFn: () => get('/api/auth/me'), staleTime: 60_000 });
  const [editing, setEditing] = useState(false);
  const u = { ...user, ...(me.data?.user || {}) };
  const admin = u.role === 'ADMIN';
  return (
    <>
      <PageHeader title={admin ? 'Profile & Team' : 'Profile'} subtitle="Your details and account security — all in one place." />
      <div className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
        <section className="card p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-5">
              <div className="relative"><Avatar name={u.name} size="lg" /><BadgeCheck className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-card text-emerald-500" /></div>
              <div>
                <div className="text-2xl font-semibold">{u.name}</div>
                <div className="text-sm text-muted">{u.email}</div>
                <div className="mt-2 flex flex-wrap gap-1.5"><Badge color="green"><BadgeCheck className="h-3 w-3" />Verified</Badge><Badge color="blue">{admin ? <><Crown className="h-3 w-3" />Administrator</> : u.title || 'Employee'}</Badge></div>
              </div>
            </div>
            <Button variant="outline" icon={Pencil} onClick={() => setEditing(true)}>Edit profile</Button>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <InfoTile icon={User} label="Full name" value={u.name} />
            <InfoTile icon={Mail} label="Email" value={u.email} />
            <InfoTile icon={Phone} label="Phone" value={u.phone} />
            <InfoTile icon={Briefcase} label="Role" value={admin ? 'Administrator' : u.title || 'Employee'} />
          </div>
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted"><Calendar className="h-3.5 w-3.5" /> Profile details are visible to administrators. Last refreshed {fmt.time(new Date())}.</p>
        </section>
        {admin ? <TeamCard /> : <QuotaCard />}
      </div>
      <section className="card mt-5 p-6 sm:p-8"><SecurityPanel /></section>
      {editing && <EditProfile open onClose={() => { setEditing(false); invalidate('me'); }} user={u} />}
      {me.error && <ErrorBox error={me.error} />}
    </>
  );
}
