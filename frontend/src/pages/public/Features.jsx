import {
  AtSign,
  BarChart3,
  Bell,
  CalendarClock,
  FileText,
  Gauge,
  Inbox,
  KeyRound,
  Lock,
  MailX,
  Moon,
  Repeat,
  ScrollText,
  Send,
  ShieldAlert,
  ShieldCheck,
  Users,
  Zap,
} from "lucide-react";
import PublicLayout, { PageHero, Section, SignInCta } from "./PublicLayout.jsx";

const GROUPS = [
  {
    title: "For employees",
    subtitle: "A complete campaign workspace",
    items: [
      [
        AtSign,
        "Connect your mailboxes",
        "Gmail & Workspace (Google sign-in), Zoho, Yahoo, Rediffmail, Amazon SES (API or SMTP) and custom SMTP. Each connection is tested for SMTP, IMAP, SPF and DMARC.",
      ],
      [
        FileText,
        "Pitches with versions",
        "Write pitches in a normal editor (bold, italic, highlight, colours, lists, links) with one-click Format, up to 10 subject lines you can rotate, {{firstName}}-style personalisation and desktop/mobile preview. Editing never rewrites past campaigns.",
      ],
      [
        Users,
        "Recipient lists",
        "CSV import with duplicate, invalid and suppressed detection, custom fields and consent source.",
      ],
      [
        Send,
        "Campaign builder",
        "Choose recipients, pitch, mailbox and speed, review the time estimate, send a test, then start or schedule.",
      ],
      [
        Repeat,
        "Original-thread follow-ups",
        "Follow-ups use the original mailbox and thread. If that mailbox is unavailable the recipient is held — never silently switched.",
      ],
      [
        Inbox,
        "Unified reply inbox",
        "Replies and bounces detected over IMAP, matched to the campaign and recipient, and excluded from future follow-ups.",
      ],
    ],
  },
  {
    title: "For administrators",
    subtitle: "Control without micromanaging",
    items: [
      [
        Users,
        "Employee management",
        "Create, edit and deactivate employees, reset passwords, and optionally require approval before campaigns start.",
      ],
      [
        Gauge,
        "Layered limits",
        "Default and per-employee account limits, daily and hourly sending limits, per-account caps and warm-up ramps — the lowest applicable limit always wins.",
      ],
      [
        ShieldAlert,
        "Emergency controls",
        "Stop all sending, one employee, or one mailbox instantly — without losing any campaign data.",
      ],
      [
        BarChart3,
        "Monitoring & reports",
        "Mailbox health, deliverability, per-employee analytics, stuck-campaign detection and a full audit log.",
      ],
      [
        KeyRound,
        "Email OTP sign-in",
        "Turn on a 6-digit email code for employee sign-ins (and optionally admins) from one switch.",
      ],
      [
        Bell,
        "Alerts",
        "Notifications for authentication failures, auto-paused accounts, approvals and service recovery.",
      ],
    ],
  },
  {
    title: "Reliability & compliance",
    subtitle: "Safe by design",
    items: [
      [
        Zap,
        "Shared rate limiting",
        "Three campaigns on one mailbox share a single limiter, so the mailbox maximum is never exceeded.",
      ],
      [
        ShieldCheck,
        "No duplicate sends",
        "Idempotent attempts, crash recovery and Sent-folder reconciliation for uncertain outcomes.",
      ],
      [
        CalendarClock,
        "Scheduling that recovers",
        "Scheduled campaigns start exactly once — even after a restart.",
      ],
      [
        MailX,
        "Unsubscribe & suppression",
        "RFC 8058 one-click unsubscribe headers plus a footer link, and organisation-wide suppression of unsubscribes, hard bounces and invalid addresses.",
      ],
      [
        Lock,
        "Security",
        "Argon2id passwords, rotating refresh tokens, AES-256-GCM credential encryption, strict CORS, CSRF protection and per-employee data isolation.",
      ],
      [
        ScrollText,
        "Audit trail",
        "Every send attempt records the mailbox, time and provider response.",
      ],
    ],
  },
];

export default function Features() {
  return (
    <PublicLayout>
      <PageHero
        eyebrow="Features"
        title={
          <>
            Powerful for employees,{" "}
            <span className="text-gradient">safe for admins</span>
          </>
        }
        subtitle="Every capability Emails Pro offers, from the first CSV import to the last reply."
      />
      {GROUPS.map((g) => (
        <Section
          key={g.title}
          className="mt-16"
          eyebrow={g.subtitle}
          title={g.title}
        >
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map(([I, t, d]) => (
              <div
                key={t}
                className="card group p-6 transition hover:-translate-y-1"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-subtle text-fg2 transition group-hover:bg-brand-500 group-hover:text-white">
                  <I className="h-5 w-5" strokeWidth={1.8} />
                </span>
                <h3 className="mt-4 font-semibold text-fg">{t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{d}</p>
              </div>
            ))}
          </div>
        </Section>
      ))}
      <Section className="mt-16">
        <div className="card flex flex-col items-center justify-between gap-4 p-8 sm:flex-row">
          <div className="flex items-center gap-4">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-subtle">
              <Moon className="h-5 w-5 text-fg2" />
            </span>
            <div>
              <b className="text-fg">Light and dark mode everywhere</b>
              <p className="text-sm text-muted">
                Switch any time from the sun/moon toggle.
              </p>
            </div>
          </div>
          <SignInCta />
        </div>
      </Section>
    </PublicLayout>
  );
}
