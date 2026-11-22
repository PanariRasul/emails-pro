import { useState } from 'react';
import { Gauge, Lock, Palette } from 'lucide-react';
import { useAuth } from '../../store/auth.js';
import { PageHeader, Notice } from '../../components/ui.jsx';
import { AppearancePanel, PanelTitle, SecurityPanel, SettingsShell } from '../../components/SettingsKit.jsx';

const TABS = [
  { id: 'appearance', label: 'Appearance', desc: 'Theme and motion', icon: Palette },
  { id: 'security', label: 'Security', desc: 'Password and devices', icon: Lock },
  { id: 'limits', label: 'Sending limits', desc: 'Set by your administrator', icon: Gauge },
];

function LimitsPanel() {
  const user = useAuth((s) => s.user);
  const l = user.limits || {};
  const rows = [['Email accounts you can connect', l.accounts], ['Emails per day (all accounts)', l.daily], ['Max emails per hour, per account', l.hourly], ['Working campaigns at once', l.maxWorkingCampaigns]];
  return (
    <>
      <PanelTitle title="Sending limits" subtitle="Your administrator sets these. The lowest applicable limit always applies." />
      <div className="grid gap-4 sm:grid-cols-2">
        {rows.map(([k, v]) => <div key={k} className="rounded-2xl bg-subtle p-5"><div className="text-sm text-muted">{k}</div><div className="mt-2 text-3xl font-semibold">{v ?? '—'}</div></div>)}
      </div>
      {user.requireApproval && <Notice className="mt-5">Your campaigns need administrator approval before they start.</Notice>}
      <p className="mt-5 text-xs text-muted">New mailboxes also go through a warm-up period that starts with a lower daily volume.</p>
    </>
  );
}

export default function Settings() {
  const [tab, setTab] = useState('appearance');
  return (
    <>
      <PageHeader title="Settings" subtitle="Make Emails Pro work the way you send." />
      <SettingsShell tabs={TABS} active={tab} onChange={setTab}>
        {tab === 'appearance' && <AppearancePanel />}
        {tab === 'security' && <SecurityPanel />}
        {tab === 'limits' && <LimitsPanel />}
      </SettingsShell>
    </>
  );
}
