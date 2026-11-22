import { useState } from 'react';
import { AtSign, BarChart3, FileText, Gauge, Inbox, KeyRound, Repeat, Send, ShieldCheck, Users, UserPlus, FlaskConical } from 'lucide-react';
import PublicLayout, { PageHero, Section, SignInCta } from './PublicLayout.jsx';
import { Segmented } from '../../components/ui.jsx';

const STEPS = {
  employee: [
    [KeyRound, 'Sign in', 'Use the email and password your admin gave you. If email verification is on, enter the 6-digit code we send to your inbox. Change your password under Profile.'],
    [AtSign, 'Connect your mailboxes', 'Go to Accounts → Connect account. Gmail/Workspace: use “Sign in with Google”. Others: enter SMTP/IMAP details or an app password. Emails Pro tests the connection before saving.'],
    [Users, 'Import recipients', 'Recipients → create a list → Import CSV. Include an email column; firstName, company and any other column become personalisation variables.'],
    [FileText, 'Write a pitch', 'Pitches → New pitch. Add subject lines and the message. Use {{firstName}}, {{companyName}}, {{employeeName}}. The preview shows desktop and mobile.'],
    [Send, 'Create the campaign', 'Create campaign → choose lists, mailbox, speed and pitch → Create draft. Review the time estimate, then send yourself a test.'],
    [Gauge, 'Start or schedule', 'Start now or pick a time. Sending respects your limits automatically; you can pause, resume or cancel at any time.'],
    [Repeat, 'Follow up', 'From a campaign that has sent, choose Create follow-up. Replied, bounced and unsubscribed recipients are removed for you; remove anyone else you like.'],
    [Inbox, 'Track replies', 'Replies appear in Inbox and on the campaign. Analytics shows trends — remember opens and clicks are approximate.'],
  ],
  admin: [
    [KeyRound, 'Sign in as admin', 'The first admin is created on first start-up. Sign in and change the password from Profile.'],
    [Gauge, 'Set policies', 'Policies & settings: default and maximum account limits, daily/hourly limits, working-campaign limit, warm-up, retries and the unsubscribe footer style.'],
    [ShieldCheck, 'Turn on email OTP (optional)', 'Login security: connect the OTP mailbox (Google sign-in recommended) or set its app password, send a test, then switch on “Email OTP for employees”.'],
    [UserPlus, 'Add employees', 'Employees → New employee. Override account, daily or hourly limits per person and require campaign approval if you want.'],
    [FlaskConical, 'Monitor mailboxes', 'SMTP monitoring shows health, usage and warm-up. Adjust per-account caps, pause or disable a mailbox.'],
    [Send, 'Oversee campaigns', 'Campaign monitoring lets you view, approve, decline or pause campaigns. Admins cannot create or send campaigns.'],
    [BarChart3, 'Review results', 'Deliverability, Reports and Audit logs show what was sent, by whom, and how it performed.'],
  ],
};

export default function HowTo() {
  const [who, setWho] = useState('employee');
  return (
    <PublicLayout>
      <PageHero eyebrow="How to use" title={<>Up and running <span className="text-gradient">in minutes</span></>} subtitle="A step-by-step guide for employees and administrators.">
        <Segmented value={who} onChange={setWho} options={[['employee', 'I\'m an employee'], ['admin', 'I\'m an admin']]} />
      </PageHero>
      <Section>
        <ol className="relative mx-auto max-w-3xl">
          <span className="absolute bottom-6 left-6 top-6 w-px bg-line" aria-hidden="true" />
          {STEPS[who].map(([I, t, d], i) => (
            <li key={`${who}-${t}`} className="relative mb-5 flex gap-5" style={{ animation: `fade-up .5s ${i * 0.06}s both` }}>
              <span className="relative z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-inv text-inv-fg shadow-lg"><I className="h-5 w-5" /></span>
              <div className="card flex-1 p-5">
                <div className="text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-300">Step {i + 1}</div>
                <h3 className="mt-1 text-lg font-semibold text-fg">{t}</h3>
                <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{d}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-10 flex justify-center"><SignInCta size="lg" /></div>
      </Section>
    </PublicLayout>
  );
}
