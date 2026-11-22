import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Badge, cx } from './ui.jsx';

/**
 * Choose one or many sending mailboxes. Groups ("Gmail", "Zoho team" …) select all their mailboxes at once.
 * Recipients are later split evenly between the chosen mailboxes.
 */
export default function AccountPicker({ accounts, value, onChange, recipients = 0, ratePerAccount = 0 }) {
  const [q, setQ] = useState('');
  const selected = useMemo(() => new Set(value), [value]);
  const groups = useMemo(() => {
    const m = new Map();
    for (const a of accounts) { const g = a.groupName || 'No group'; m.set(g, [...(m.get(g) || []), a.id]); }
    return [...m.entries()].sort(([a], [b]) => (a === 'No group') - (b === 'No group') || a.localeCompare(b));
  }, [accounts]);
  const shown = accounts.filter((a) => !q || `${a.email} ${a.displayName || ''} ${a.groupName || ''}`.toLowerCase().includes(q.toLowerCase()));

  const set = (ids) => onChange(accounts.map((a) => a.id).filter((id) => ids.has(id))); // keep a stable order
  const toggle = (id) => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); set(n); };
  const toggleMany = (ids) => {
    const all = ids.every((id) => selected.has(id));
    const n = new Set(selected);
    ids.forEach((id) => (all ? n.delete(id) : n.add(id)));
    set(n);
  };
  const allIds = accounts.map((a) => a.id);
  const perAccount = value.length ? Math.ceil(recipients / value.length) : 0;
  const dailyLeft = accounts.filter((a) => selected.has(a.id)).reduce((s, a) => s + Math.max(0, a.limits.daily - a.usage.day), 0);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <GroupChip label="All" count={allIds.length} active={allIds.length > 0 && allIds.every((id) => selected.has(id))} onClick={() => toggleMany(allIds)} />
        {groups.length > 1 && groups.map(([g, ids]) => (
          <GroupChip key={g} label={g} count={ids.length} active={ids.every((id) => selected.has(id))} partial={ids.some((id) => selected.has(id))} onClick={() => toggleMany(ids)} />
        ))}
      </div>
      {accounts.length > 6 && (
        <div className="relative"><Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" /><input className="input h-9 pl-9 text-sm" placeholder="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      )}
      <div className="max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-line p-1.5">
        {shown.map((a) => {
          const left = Math.max(0, a.limits.daily - a.usage.day);
          return (
            <label key={a.id} className={cx('flex cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 transition', selected.has(a.id) ? 'bg-brand-500/[.08]' : 'hover:bg-subtle')}>
              <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-fg">{a.email}</span>
                <span className="block truncate text-xs text-muted">{a.displayName || 'no sender name'}{a.groupName ? ` · ${a.groupName}` : ''}</span>
              </span>
              <span className="shrink-0 text-right text-[11px] text-muted">
                {left} left today{a.limits.warmup && <><br /><Badge color="blue">warm-up day {a.limits.warmup.day}/{a.limits.warmup.totalDays}</Badge></>}
              </span>
            </label>
          );
        })}
        {!shown.length && <div className="p-3 text-center text-xs text-muted">No matching accounts</div>}
      </div>
      <p className="text-xs text-muted">
        {value.length === 0 ? 'Choose at least one account.' : (
          <>
            <b className="text-fg2">{value.length} account{value.length === 1 ? '' : 's'}</b>
            {recipients > 0 && value.length > 1 && <> · {recipients} recipients split evenly ≈ <b className="text-fg2">{perAccount} each</b></>}
            {ratePerAccount > 0 && <> · up to {ratePerAccount * value.length}/hour together</>}
            {` · ${dailyLeft} can still be sent today`}
            {value.length > 1 && '. If one account stops working, its unsent emails move to the others.'}
          </>
        )}
      </p>
    </div>
  );
}

function GroupChip({ label, count, active, partial, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={cx('rounded-full border px-3 py-1 text-xs font-medium transition', active ? 'border-transparent bg-inv text-inv-fg' : partial ? 'border-brand-400 text-brand-700 dark:text-brand-300' : 'border-line text-fg2 hover:border-brand-400')}>
      {label} <span className="opacity-70">{count}</span>
    </button>
  );
}