import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Laptop, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { get, post } from '../api/client.js';
import { useAuth } from '../store/auth.js';
import { useTheme } from '../store/theme.js';
import { Button, ErrorBox, Field, cx, fmt, toast } from './ui.jsx';

/** Left tab list + content panel (Clientra settings layout). tabs = [{ id, label, desc, icon }] */
export function SettingsShell({ tabs, active, onChange, children }) {
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <nav className="card h-fit p-3">
        {tabs.map((t) => {
          const I = t.icon;
          const on = active === t.id;
          return (
            <button key={t.id} type="button" onClick={() => onChange(t.id)} className={cx('flex w-full items-center gap-3 rounded-2xl p-3 text-left transition', on ? 'bg-subtle' : 'hover:bg-subtle/60')}>
              <span className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition', on ? 'bg-inv text-inv-fg' : 'bg-subtle text-fg2')}><I className="h-[18px] w-[18px]" strokeWidth={1.8} /></span>
              <span className="min-w-0"><span className="block text-[15px] font-medium text-fg">{t.label}</span><span className="block truncate text-xs text-muted">{t.desc}</span></span>
            </button>
          );
        })}
      </nav>
      <div className="card min-h-[420px] p-6 sm:p-8">{children}</div>
    </div>
  );
}

export function PanelTitle({ title, subtitle, actions }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold text-fg">{title}</h2>{subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}</div>
      {actions}
    </div>
  );
}

export function AppearancePanel() {
  const { mode, setMode } = useTheme();
  const opts = [['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'System', Monitor]];
  return (
    <>
      <PanelTitle title="Appearance" subtitle="Choose how Emails Pro looks on this device." />
      <div className="grid gap-4 sm:grid-cols-3">
        {opts.map(([v, l, I]) => (
          <button key={v} type="button" onClick={() => setMode(v)} className={cx('overflow-hidden rounded-3xl text-left ring-2 transition', mode === v ? 'ring-brand-500' : 'ring-line hover:ring-subtle-2')}>
            <div className={cx('h-28 p-3', v === 'dark' ? 'bg-[#0a0a0c]' : v === 'light' ? 'bg-[#edeef1]' : 'bg-gradient-to-r from-[#edeef1] from-50% to-[#0a0a0c] to-50%')}>
              <div className={cx('h-full rounded-xl p-2', v === 'dark' ? 'bg-[#151518]' : 'bg-white')}>
                <div className="h-2 w-12 rounded bg-brand-500" /><div className={cx('mt-2 h-2 w-20 rounded', v === 'dark' ? 'bg-white/20' : 'bg-black/10')} /><div className={cx('mt-1.5 h-2 w-16 rounded', v === 'dark' ? 'bg-white/10' : 'bg-black/5')} />
              </div>
            </div>
            <div className="flex items-center gap-2 bg-card px-4 py-3 text-sm font-medium"><I className="h-4 w-4" />{l}</div>
          </button>
        ))}
      </div>
      <p className="mt-5 text-xs text-muted">You can also switch any time with the sun/moon toggle on the left rail. Animations respect your system's “reduce motion” setting.</p>
    </>
  );
}

export function SecurityPanel() {
  const navigate = useNavigate();
  const clear = useAuth((s) => s.clearSession);
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get('/api/auth/sessions'), staleTime: 60_000 });
  const change = async () => {
    if (f.newPassword !== f.confirm) { setError(new Error('Passwords do not match')); return; }
    setBusy(true); setError(null);
    try {
      await post('/api/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword });
      toast.ok('Password changed — please sign in again');
      clear(); navigate('/login');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const revokeAll = async () => {
    try { await post('/api/auth/sessions/revoke-all'); toast.ok('Signed out of all devices'); clear(); navigate('/login'); } catch (err) { toast.error(err); }
  };
  const device = (ua = '') => (/(iphone|android|mobile)/i.test(ua) ? 'Mobile' : /mac/i.test(ua) ? 'Mac' : /windows/i.test(ua) ? 'Windows' : /linux/i.test(ua) ? 'Linux' : 'Browser') + (/(edg)/i.test(ua) ? ' · Edge' : /chrome/i.test(ua) ? ' · Chrome' : /firefox/i.test(ua) ? ' · Firefox' : /safari/i.test(ua) ? ' · Safari' : '');
  return (
    <>
      <PanelTitle title="Security" subtitle="Password and signed-in devices." />
      <div className="grid gap-8 xl:grid-cols-2">
        <div className="space-y-4">
          <h3 className="font-medium text-fg">Change password</h3>
          <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} /></Field>
          <Field label="New password" hint="At least 10 characters"><input className="input" type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} /></Field>
          <Field label="Confirm new password"><input className="input" type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
          <ErrorBox error={error} />
          <Button onClick={change} loading={busy} disabled={!f.currentPassword || f.newPassword.length < 10}>Update password</Button>
        </div>
        <div>
          <div className="mb-3 flex items-center justify-between"><h3 className="font-medium text-fg">Signed-in devices</h3><Button size="sm" variant="secondary" icon={LogOut} onClick={revokeAll}>Sign out everywhere</Button></div>
          <ul className="space-y-2">
            {(sessions.data?.sessions || []).map((s, i) => (
              <li key={s.id} className="flex items-center gap-3 rounded-2xl bg-subtle p-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-card"><Laptop className="h-4 w-4 text-fg2" /></span>
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{device(s.userAgent)}{i === 0 && <span className="ml-2 text-xs text-emerald-600 dark:text-emerald-400">· most recent</span>}</span><span className="block text-xs text-muted">Signed in {fmt.date(s.createdAt)} · {s.persistent ? 'remembered' : 'this session only'}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
