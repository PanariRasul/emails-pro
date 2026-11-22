import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

function TooltipBox({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-2xl bg-card px-3 py-2 text-xs shadow-xl ring-1 ring-line">
      <div className="mb-1 font-medium text-fg">{label}</div>
      {payload.map((p) => <div key={p.dataKey} className="flex items-center gap-2 text-fg2"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} />{p.name}: <b className="text-fg">{p.value}</b></div>)}
    </div>
  );
}

/** Clientra-style stacked bars: hatched brand segment on top of a solid neutral segment. */
export function StackedBars({ data, x = 'label', top = 'top', bottom = 'bottom', topName = 'Sent', bottomName = 'Replied', height = 240 }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer>
        <BarChart data={data} barCategoryGap="18%" margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
          <defs>
            <pattern id="hatchBrand" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="7" height="7" fill="#4f6ffb" />
              <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(255,255,255,0.35)" strokeWidth="3" />
            </pattern>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey={x} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          <YAxis tickLine={false} axisLine={false} allowDecimals={false} tick={{ fill: 'var(--muted)', fontSize: 12 }} />
          <Tooltip cursor={{ fill: 'var(--subtle)' }} content={<TooltipBox />} />
          <Bar dataKey={bottom} name={bottomName} stackId="a" fill="var(--fg)" radius={[6, 6, 6, 6]} maxBarSize={34} />
          <Bar dataKey={top} name={topName} stackId="a" fill="url(#hatchBrand)" radius={[6, 6, 6, 6]} maxBarSize={34} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function lastNDays(n, rows, map) {
  const byDay = new Map((rows || []).map((r) => [r.day, r]));
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    out.push({ label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), ...map(byDay.get(key) || {}) });
  }
  return out;
}
