import { Link } from 'react-router';
import { ArrowRight, AtSign, BarChart3, CheckCircle2, Gauge, Inbox, MailCheck, Repeat, Send, ShieldCheck, Sparkles, Users } from 'lucide-react';
import PublicLayout, { Section, SignInCta } from './PublicLayout.jsx';
import { FlightIllustration } from '../../components/AuthScene.jsx';

const PROVIDERS = ['Gmail', 'Google Workspace', 'Zoho Mail', 'Yahoo Mail', 'Rediffmail', 'Amazon SES', 'Custom SMTP'];

function MockDashboard() {
  const bars = [[38, 18], [52, 22], [41, 15], [60, 27], [55, 24], [72, 31], [64, 26], [80, 35]];
  return (
    <div className="relative">
      <div className="absolute -inset-6 -z-10 rounded-[40px] bg-gradient-to-br from-brand-500/25 via-sky-400/10 to-violet-500/20 blur-2xl" />
      <div className="card overflow-hidden p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <div><div className="text-xs text-muted">Good morning, Priya</div><div className="text-lg font-semibold text-fg">Campaign overview</div></div>
          <span className="rounded-full bg-emerald-500/12 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">● Sending</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="brand-gradient rounded-2xl p-3 text-white shadow-lg shadow-brand-500/25"><div className="text-[11px] text-white/80">Sent today</div><div className="mt-2 text-2xl font-semibold">1,248</div><div className="mt-1 text-[10px] text-white/80">↑ 12% vs yesterday</div></div>
          <div className="rounded-2xl bg-subtle p-3"><div className="text-[11px] text-fg2">Replies</div><div className="mt-2 text-2xl font-semibold text-fg">96</div><div className="mt-1 text-[10px] text-emerald-600 dark:text-emerald-400">↑ 9%</div></div>
          <div className="rounded-2xl bg-subtle p-3"><div className="text-[11px] text-fg2">Working</div><div className="mt-2 text-2xl font-semibold text-fg">5<span className="text-sm text-muted">/7</span></div><div className="mt-1 text-[10px] text-muted">campaigns</div></div>
        </div>
        <div className="mt-4 rounded-2xl bg-subtle p-4">
          <div className="mb-3 flex items-center justify-between text-xs"><span className="font-medium text-fg">Sent vs replied</span><span className="flex gap-3 text-muted"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-brand-500" />Sent</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-fg" />Replied</span></span></div>
          <div className="flex h-32 items-end gap-2">
            {bars.map(([a, b], i) => (
              <div key={i} className="flex h-full flex-1 flex-col justify-end gap-1" style={{ animation: `fade-up .6s ${0.3 + i * 0.07}s both` }}>
                <div className="rounded-md bg-brand-500" style={{ height: `${a}%`, backgroundImage: 'repeating-linear-gradient(135deg, rgba(255,255,255,.25) 0 2px, transparent 2px 6px)' }} />
                <div className="rounded-md bg-fg" style={{ height: `${b}%` }} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="absolute -bottom-6 -left-4 hidden w-56 animate-float rounded-2xl bg-card p-3 shadow-xl ring-1 ring-line sm:block">
        <div className="flex items-center gap-2 text-xs"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600"><MailCheck className="h-4 w-4" /></span><span><b className="block text-fg">New reply</b><span className="text-muted">Asha · Tata Forge</span></span></div>
      </div>
    </div>
  );
}

const HIGHLIGHTS = [
  [AtSign, 'Your team\'s own mailboxes', 'Employees connect Gmail, Workspace, Zoho, Yahoo, Rediffmail, Amazon SES or any SMTP — credentials encrypted with AES-256-GCM.'],
  [Gauge, 'Limits that can\'t be exceeded', 'One shared rate limiter per mailbox across every campaign, plus daily caps, warm-up and admin maximums. The lowest limit always wins.'],
  [Repeat, 'Follow-ups in the original thread', 'Follow-ups go from the same mailbox with the right In-Reply-To and References. Replied, bounced and unsubscribed contacts are excluded automatically.'],
  [ShieldCheck, 'Never a duplicate send', 'Every attempt is idempotent. If a connection drops after the server accepted a message, it is marked “unknown” and checked — never blindly resent.'],
  [Inbox, 'Replies land in one inbox', 'IMAP sync detects replies and bounces and links them to the right campaign and recipient.'],
  [BarChart3, 'Honest analytics', 'Opens and clicks are labelled approximate, likely scanner clicks are flagged, and every send has a full audit trail.'],
];

export default function Home() {
  return (
    <PublicLayout>
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-40 right-0 h-[520px] w-[720px] rounded-full bg-brand-500/15 blur-3xl" />
        <div className="relative mx-auto grid max-w-[1240px] items-center gap-14 px-4 pb-16 pt-10 sm:px-6 lg:grid-cols-2 lg:pt-16">
          <div>
            <div className="inline-flex animate-fade-up items-center gap-2 rounded-full bg-card px-4 py-1.5 text-sm text-fg2 shadow-sm ring-1 ring-line"><Sparkles className="h-4 w-4 text-brand-500" /> Email marketing for teams</div>
            <h1 className="mt-6 animate-fade-up text-5xl font-semibold leading-[1.05] tracking-tight text-fg [animation-delay:.08s] sm:text-[64px]">
              Turn emails into <span className="text-gradient italic">real business growth</span>
            </h1>
            <p className="mt-6 max-w-xl animate-fade-up text-lg text-muted [animation-delay:.16s]">
              Emails Pro lets every employee run campaigns from their own mailboxes while admins control limits, security and compliance — with sending that's safe by design.
            </p>
            <div className="mt-8 flex animate-fade-up flex-wrap gap-3 [animation-delay:.24s]">
              <SignInCta size="lg" label="Get started" />
              <Link to="/how-to-use" className="inline-flex h-12 items-center gap-2 rounded-full bg-card px-6 text-[15px] font-medium text-fg shadow-sm ring-1 ring-line hover:bg-subtle">See how it works</Link>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
              {['Admin-controlled limits', 'One-click unsubscribe built in', 'Light & dark mode'].map((t) => <li key={t} className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-emerald-500" />{t}</li>)}
            </ul>
          </div>
          <MockDashboard />
        </div>
      </section>

      <Section className="mt-6">
        <div className="card flex flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 py-6 text-sm font-medium text-muted">
          <span className="text-fg2">Works with</span>
          {PROVIDERS.map((p) => <span key={p}>{p}</span>)}
        </div>
      </Section>

      <Section className="mt-24" eyebrow="Built for teams" title="Everything a sales team needs to send with confidence" subtitle="Employees own campaigns and mailboxes. Admins own the rules. The backend enforces both.">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {HIGHLIGHTS.map(([I, t, d], i) => (
            <div key={t} className="card group p-6 transition hover:-translate-y-1" style={{ animation: `fade-up .6s ${i * 0.06}s both` }}>
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-500/10 text-brand-600 transition group-hover:scale-110 dark:text-brand-300"><I className="h-6 w-6" strokeWidth={1.7} /></span>
              <h3 className="mt-5 text-lg font-semibold text-fg">{t}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{d}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 text-center"><Link to="/features" className="inline-flex items-center gap-1.5 font-medium text-brand-600 hover:underline dark:text-brand-300">Explore all features <ArrowRight className="h-4 w-4" /></Link></div>
      </Section>

      <Section className="mt-24">
        <div className="relative overflow-hidden rounded-[36px] bg-[#041235] px-6 py-14 text-white sm:px-14">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_80%_0%,rgba(58,99,251,0.55),transparent_55%),radial-gradient(ellipse_at_0%_100%,rgba(56,189,248,0.3),transparent_50%)]" />
          <div className="relative grid items-center gap-10 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">From list to replies in four steps</h2>
              <ol className="mt-8 space-y-4">
                {[[Users, 'Import recipients', 'CSV upload with duplicate, invalid and suppression checks.'], [AtSign, 'Pick a mailbox and speed', 'Within your admin\'s limits — shared fairly across campaigns.'], [Send, 'Test, then start or schedule', 'Review the estimate, send yourself a test, go.'], [Repeat, 'Follow up & watch replies', 'Same sender, same thread. Replies show up in your inbox.']].map(([I, t, d], i) => (
                  <li key={t} className="flex gap-4"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/15"><I className="h-5 w-5 text-sky-300" /></span><span><b className="block">{i + 1}. {t}</b><span className="text-sm text-sky-100/75">{d}</span></span></li>
                ))}
              </ol>
              <Link to="/how-to-use" className="mt-8 inline-flex h-12 items-center gap-2 rounded-full bg-white px-6 font-medium text-slate-900 hover:bg-sky-50">Read the guide <ArrowRight className="h-4 w-4" /></Link>
            </div>
            <div className="hidden lg:block"><FlightIllustration /></div>
          </div>
        </div>
      </Section>

      <Section className="mt-24">
        <div className="card flex flex-col items-center gap-5 px-6 py-14 text-center">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Ready to send smarter?</h2>
          <p className="max-w-xl text-muted">Sign in with the account your administrator created for you. New here? Ask your admin to invite you.</p>
          <SignInCta size="lg" />
        </div>
      </Section>
    </PublicLayout>
  );
}
