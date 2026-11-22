# Emails Pro

Email campaign CRM with **employee-owned mailboxes** and **admin-controlled limits**, built to run on free hosting:

| Layer | Platform | Stack |
|---|---|---|
| Frontend | Render **Free Static Site** | React 19 + Vite 6, Tailwind 4, TanStack Query, Zustand, React Router 7 |
| Backend | Render **Free Web Service** | Node 22 + Express 4, in-process background worker |
| Database | **Neon Free** PostgreSQL | Prisma 6 (Rust-free client via `pg` driver adapter) |
| Queue / cache | PostgreSQL (Redis optional) | atomic claims, quota counters, bounded in-memory caches |

> **Read first:** [docs/FREE_TIER_LIMITS.md](docs/FREE_TIER_LIMITS.md). Render Free sleeps when idle and **blocks outbound SMTP ports 25/465/587**. Emails Pro therefore also sends through the **Gmail API** (Google sign-in) and the **Amazon SES API** over HTTPS. The hosting audit is in [docs/AUDIT.md](docs/AUDIT.md).

## Features

**Admin** (management only; cannot create or send campaigns)
- Employees: create, edit, deactivate, reset passwords, require campaign approval
- Account limits: system default (100), system maximum, per-employee override, live slot counts
- Sending policy: daily/hourly per employee, per-account caps, warm-up ramp, auto-pause on high bounce rate
- Monitoring: SMTP/IMAP health, campaigns (pause, approve, decline), deliverability, reports, audit log
- System health: API/DB/worker/Redis/SMTP egress, sleep-gap history, live availability monitor with alerts
- Emergency stop: global, per employee, per account

**Employee**
- Connect Gmail/Workspace (Google sign-in), Zoho, Yahoo, Rediffmail, Amazon SES (API or SMTP) and custom SMTP. Each connection is tested for SMTP, IMAP, SPF and DMARC, and credentials are AES-256-GCM encrypted
- Versioned pitches with personalisation (`{{firstName}}`, `{{companyName}}`, `{{employeeName}}`, any CSV column) and desktop/mobile preview
- Recipient lists with CSV import, duplicate/invalid/suppressed detection and consent source
- Campaigns: review and estimate, test send, start or schedule, pause/resume/cancel/archive, at most 7 working campaigns
- Sending speed chosen within the admin limit, with **one shared limiter per account across all campaigns**
- Follow-ups from the **original mailbox** in the **original thread**. Replied, unsubscribed and bounced recipients are excluded; recipients whose mailbox is unavailable are held, never switched
- Inbox of detected replies and bounces (IMAP), analytics, full sending history, failed-email export and retry, suppression list

**Sign-in:** an animated sign-in page in light and dark mode; optional **email OTP** (an admin switch, with codes sent to the employee's own email); **Forgot password** via emailed code; optional “Continue with Google / Microsoft” for existing users; “Remember me”; device list and sign-out everywhere.

**Design:** a redesigned UI in both light and dark mode (top navigation, icon rail, ⌘K command palette, notifications, profile menu, Help Center), plus public **Home, Features, How to use and Why Emails Pro** pages.

**Reliability:** idempotent send attempts; duplicate-send protection that tracks the SMTP phase (a drop after `DATA` becomes `UNKNOWN` and is reconciled against the Sent folder); crash and sleep recovery; exactly-once scheduling; graceful shutdown.

**Compliance:** RFC 8058 one-click unsubscribe plus a mandatory footer link; org-wide suppression of unsubscribes, hard bounces and invalid addresses; opens and clicks labelled as approximate.

## Repository layout

```
emails-pro/
├── render.yaml                  Render Blueprint (API + static site, Free plan)
├── .github/workflows/ci.yml     Migrations drift check, unit + e2e tests, frontend build
├── backend/
│   ├── prisma/schema.prisma     19 models
│   ├── prisma/migrations/       committed SQL migrations (applied with `migrate deploy`)
│   ├── src/
│   │   ├── server.js            boot, graceful shutdown, bootstrap admin
│   │   ├── app.js               Express app, security middleware, routes
│   │   ├── routes/              auth, accounts (+OAuth), campaigns, content, inbox, admin, public
│   │   ├── services/            limits, template, smtp, smtpPhase, transports (Gmail/SES), imap, oauth, egress
│   │   ├── worker/              lease loop, sender, quota, maintenance, health
│   │   └── lib/                 prisma, crypto, cache, logger, redis (optional), rate limit
│   └── test/                    unit, e2e (fake SMTP + mock SES), recovery
├── frontend/
│   └── src/
│       ├── api/client.js        timeouts, cold-start retries (GET only), single-flight refresh
│       ├── pages/employee/      11 pages
│       ├── pages/admin/         10 pages
│       └── components/          layout, connection banner, UI kit
└── docs/                        AUDIT · DEPLOYMENT · FREE_TIER_LIMITS · OPERATIONS
```

## Run locally

Requirements: Node 22, PostgreSQL 14+.

```bash
# 1. Database
createdb emailspro

# 2. Backend (terminal 1)
cd backend
npm install
cp .env.example .env            # fill in DATABASE_URL, ENCRYPTION_KEY, SYSTEM_MAIL_APP_PASSWORD …
npx prisma migrate deploy
npm run dev                      # http://localhost:10000  (dev mode generates temporary secrets)

# 3. Frontend (terminal 2)
cd frontend
npm install
npm run dev                      # http://localhost:5173  (proxies /api to :10000)
```

For persistent local sessions and credentials, also export `JWT_SECRET` (any long string) and `ENCRYPTION_KEY` (`openssl rand -base64 32`). To test sending against a local SMTP catcher without TLS, set `SMTP_DEV_INSECURE=1` (ignored in production).

## Tests

```bash
cd backend
npm test                                                     # 13 unit tests
E2E_DATABASE_URL=postgresql://localhost:5432/emailspro_test npm run test:db   # 16 e2e + recovery tests
```

`test:db` needs a **disposable** database with migrations applied. It creates its own users and never deletes data.

## Deploy

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**: Neon project → Render Blueprint → environment values → first admin login.

## Security notes

- Passwords: Argon2id. Sessions: 15-minute access JWT (memory only) plus a rotating HttpOnly refresh cookie with reuse detection.
- Every API route checks role **and** ownership on the server. Admin routes are admin-only, and campaign routes are employee-only.
- Mail credentials and OAuth tokens are encrypted with AES-256-GCM, never returned by the API, and redacted from logs. Key rotation is supported.
- Helmet, strict CORS, CSRF guard on cookie endpoints, Zod validation, request size limits and timeouts, login rate limiting.
- Email HTML is sanitised on save; received HTML is sanitised and rendered in a sandboxed iframe; click links are HMAC-signed (no open redirect).
