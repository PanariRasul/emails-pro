import { Check, Eye, Gauge, Lock, Repeat, Scale, ShieldCheck, X } from 'lucide-react';
import PublicLayout, { PageHero, Section, SignInCta } from './PublicLayout.jsx';
import { cx } from '../../components/ui.jsx';

const ROWS = [
  ['Each employee sends from their own mailboxes', true, 'Often one shared sending account'],
  ['One shared limiter per mailbox across all campaigns', true, 'Limits per campaign — easy to exceed'],
  ['Admin limits that employees cannot override', true, 'Usually per-user settings only'],
  ['Uncertain sends marked “unknown” and reconciled, never resent', true, 'Blind retries can duplicate emails'],
  ['Follow-ups from the original mailbox, in the original thread', true, 'New thread, sometimes another sender'],
  ['Mandatory one-click unsubscribe and org-wide suppression', true, 'Often optional or removable'],
  ['Admins monitor and pause, but cannot send as employees', true, 'Shared full access'],
  ['Opens and clicks labelled approximate; scanner clicks flagged', true, 'Presented as exact engagement'],
];

const PRINCIPLES = [
  [Gauge, 'Control', 'The backend enforces every limit and permission — hiding a button is never the security.'],
  [ShieldCheck, 'Safety', 'Idempotent sending, crash recovery and exactly-once scheduling protect your reputation.'],
  [Repeat, 'Continuity', 'Conversations stay in one thread with one sender, so replies keep flowing.'],
  [Lock, 'Privacy', 'Credentials are encrypted, never returned by the API and never logged. Employees can\'t see each other\'s data.'],
  [Eye, 'Honesty', 'No promises of inbox placement or spam-free delivery — just authentication checks, pacing and clean lists.'],
  [Scale, 'Compliance', 'RFC 8058 one-click unsubscribe headers that meet Gmail and Yahoo bulk-sender rules.'],
];

export default function Why() {
  return (
    <PublicLayout>
      <PageHero eyebrow="Why Emails Pro" title={<>Built for teams that <span className="text-gradient">can't afford mistakes</span></>} subtitle="Bulk mailers optimise for volume. Emails Pro optimises for doing it right — every send, every follow-up, every time." />
      <Section>
        <div className="card overflow-hidden p-2 sm:p-3">
          <table className="w-full border-separate border-spacing-0 text-left">
            <thead>
              <tr>
                <th className="rounded-l-2xl bg-subtle px-5 py-4 text-sm font-medium text-muted">Capability</th>
                <th className="bg-subtle px-5 py-4 text-center text-sm font-semibold text-brand-600 dark:text-brand-300">Emails Pro</th>
                <th className="rounded-r-2xl bg-subtle px-5 py-4 text-sm font-medium text-muted">Typical bulk mailer</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([cap, ours, theirs], i) => (
                <tr key={cap} className={cx(i % 2 && 'bg-subtle/40')}>
                  <td className="border-b border-line px-5 py-4 text-[15px] text-fg">{cap}</td>
                  <td className="border-b border-line px-5 py-4 text-center">{ours && <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"><Check className="h-4 w-4" /></span>}</td>
                  <td className="border-b border-line px-5 py-4 text-sm text-muted"><span className="inline-flex items-center gap-2"><X className="h-4 w-4 shrink-0 text-red-500" />{theirs}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-center text-xs text-faint">Comparison describes common patterns in generic bulk-email tools, not any specific product.</p>
      </Section>
      <Section className="mt-20" eyebrow="Our principles" title="What makes it the right choice">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {PRINCIPLES.map(([I, t, d]) => (
            <div key={t} className="card p-6">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl brand-gradient text-white shadow-lg shadow-brand-500/25"><I className="h-6 w-6" strokeWidth={1.7} /></span>
              <h3 className="mt-5 text-lg font-semibold text-fg">{t}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{d}</p>
            </div>
          ))}
        </div>
        <div className="mt-12 flex justify-center"><SignInCta size="lg" /></div>
      </Section>
    </PublicLayout>
  );
}
