# Emails Pro — Free-Hosting Compatibility Audit

**Target:** Render Free Static Site (frontend) · Render Free Web Service (backend) · Neon Free PostgreSQL · Prisma · optional Redis
**Audit date:** 20 Nov 2026

## Scope and starting point

The deployment brief asks for the existing source to be inspected before anything changes. The `abacco-crm` and `abacco-marketing` repositories were **not reachable from the build environment** (no GitHub connection), so this codebase is a **clean implementation of the Abacco / Emails Pro architecture plan**, built to the free-hosting brief from the start.

If you later merge it into `abacco-crm`, map the models with care (see *Merging into an existing repo* at the end). Do not overwrite working modules.

---

## 1. Hosting compatibility issues found in the original architecture

| # | Original plan | Problem on the free stack | Severity | Resolution in this build |
|---|---|---|---|---|
| 1 | Send through employees' SMTP servers (Nodemailer) | **Render Free web services cannot open outbound connections on ports 25, 465 or 587** (Render changelog, Sep 2025; Render "Deploy for Free" docs). Gmail, Zoho, Yahoo and Rediffmail SMTP all use those ports. | **Blocker** | Added **HTTPS delivery transports**: the **Gmail API** for Google-connected accounts (OAuth) and the **Amazon SES v2 API** (SigV4). SMTP stays available for relays on **port 2525** and for paid instances. A startup **egress probe** detects blocked ports, and the UI explains the cause and the options. |
| 2 | Separate worker and scheduler processes (BullMQ consumers) | Render Free has **no background-worker service type**. A second free web service would sleep independently. | High | The **in-process worker** runs inside the API service, separated by module. A **PostgreSQL lease** guarantees that only one scheduler/sender runs, even during deploy overlap. `RUN_WORKER=false` lets you split it out later. |
| 3 | Redis + BullMQ mandatory (queues, rate limits) | No suitable free Redis was confirmed. Render's free Key Value store is not durable enough for queues. | High | **PostgreSQL-backed scheduling**: state-driven, with atomic `FOR UPDATE SKIP LOCKED` claims and atomic quota counters. Redis is **optional**: if `REDIS_URL` is set it is used only for shared request rate limiting and readiness checks. PostgreSQL is always the source of truth. |
| 4 | Workers assumed always on | Free web services **spin down after 15 minutes without inbound traffic** and take about a minute to start. Scheduled sends and IMAP sync stop while asleep. | High | The worker **recovers on wake**: it records the sleep gap, starts overdue scheduled campaigns once (conditional updates), and reconciles interrupted sends. The UI shows late starts and "Connecting to Emails Pro…". **No keep-alive pings** are used. |
| 5 | Neon compute suspends when idle | First query after about 5 minutes idle hits a cold start, and idle pooled connections are dropped. | Medium | A `pg` pool with an `error` handler (a dropped idle connection can't crash the process), 20 s connect timeout, DB retry with backoff and jitter for idempotent work, `503 DB_UNAVAILABLE` + `Retry-After` for the frontend, and GET retries with backoff in the client. |
| 6 | Neon connection limits | Many PrismaClients or a large pool would exhaust connections. | Medium | **One PrismaClient per process**, a pool of `DB_POOL_MAX=5`, the Neon **pooled** URL for the app and the **direct** URL for migrations only. |
| 7 | Neon Free storage (1 GB per project) | Storing every inbound email or unbounded logs would fill it. | Medium | Only **campaign-related** replies and bounces are stored, with message bodies capped. Usage counters, health checks, expired refresh tokens and read notifications are **pruned** automatically. Recipient tables are paginated and indexed. |
| 8 | Docker + Caddy/Nginx, separate migration job | Not applicable to Render native runtimes. Pre-deploy commands are not available on Free. | Low | Native Node runtime. `prisma migrate deploy` runs in the **build command**, the controlled deployment step, and it never resets data. `prisma migrate dev` is never used in production. |
| 9 | Cross-site cookie auth between two `onrender.com` subdomains | `onrender.com` is a public suffix, so the frontend and API are different sites. Safari and other browsers block third-party cookies, which would break refresh tokens. | Medium | The static site **rewrites `/api/*` to the backend**, so the API is same-origin and the HttpOnly refresh cookie is first-party. CORS remains configured for direct access. |
| 10 | Render Free has 512 MB RAM | A heavy ORM engine, large in-memory caches and unbounded concurrency risk OOM. | Medium | The **Rust-free Prisma client** (Wasm query compiler + `pg` adapter, so no native engine process), `--max-old-space-size=384`, bounded LRU caches, bounded SMTP transport pool, cursor pagination, small send batches. Measured RSS was about 180 MB with the worker running. |
| 11 | In-memory rate limits / locks | Lost on restart and wrong across instances. | Medium | Account quotas and pacing slots live in **PostgreSQL** (atomic `INSERT … ON CONFLICT … WHERE count < limit`). In-memory caches hold disposable read-only data only. |
| 12 | Uncertain SMTP outcomes | Nodemailer labels **every socket error as `command: "CONN"`**, even after `DATA`, so naive retry logic would send duplicates. | **High** (found during testing) | SMTP phase tracking stamps `dataPhase` on errors. Only failures **before `DATA`** are retried. Anything later becomes **UNKNOWN**, which is reconciled against the Sent folder via IMAP and never blindly resent. The HTTPS transports apply the same rule. |

---

## 2. What works on the pure free stack (no paid services)

| Capability | Free stack | Notes |
|---|---|---|
| Gmail / Google Workspace sending | ✅ | Google sign-in → **Gmail API** over HTTPS. Requires a Google Cloud OAuth client (free). |
| Amazon SES sending | ✅ | **SES API** over HTTPS with IAM keys. SES itself is paid per email and its sandbox limits apply. |
| SMTP relays on port 2525 | ✅ | E.g. providers that accept submissions on 2525. |
| Zoho / Yahoo / Rediffmail / most custom SMTP (465/587) | ❌ on Render Free | Works unchanged if the backend runs on any **paid** Render instance (SMTP ports open there; port 25 stays blocked everywhere on Render). |
| Reply & bounce detection (IMAP, port 993) | ✅ | Not affected by the SMTP block. Runs only while the service is awake. |
| Scheduled campaigns | ⚠️ | They start when the service is awake. A sleeping service starts them late, never twice. |
| 24/7 sending | ❌ | Not possible on Render Free. Not promised anywhere in the UI or docs. |

---

## 3. Implementation stages delivered

1. **Foundation**: schema (19 models), config, logging with secret redaction, AES-256-GCM credentials, Argon2id passwords, rotating refresh tokens with reuse detection.
2. **Employees & policies**: admin CRUD, default and individual account limits, daily/hourly limits, approval requirement, audit log.
3. **Email accounts**: provider presets, SMTP/IMAP/SPF/DMARC tests, Google OAuth, SES API, the transactional account limit, soft delete that keeps history, reconnect without creating duplicates.
4. **Pitches, lists, campaigns**: versioned pitches, CSV import, suppression-aware snapshots, the 7-working-campaign limit, review, test send, scheduling, approval.
5. **Sending engine**: lease-elected worker, atomic recipient claims, a shared per-account limiter, warm-up, retries with backoff and jitter, UNKNOWN reconciliation, pause/resume/cancel.
6. **Follow-ups & inbox**: original-sender enforcement (held, never switched), threading headers, IMAP reply and bounce sync.
7. **Tracking & compliance**: signed click redirects, open pixel with scanner heuristics, RFC 8058 one-click unsubscribe, org-wide suppression.
8. **Monitoring**: `/health`, `/ready`, the admin health page (server history plus a live browser monitor with alerts), deliverability, reports, emergency stop.
9. **Free-hosting hardening**: everything in section 1, plus the CI workflow and Render Blueprint.

## 4. Verification performed

- **13 unit tests**: crypto, limit precedence, warm-up, SMTP classification, **phase tracking against a real SMTP server**, template escaping and sanitising, unsubscribe headers, signed links, the bounded cache, and the **AWS SigV4 published test vector**.
- **13 end-to-end tests**: the real API process, real PostgreSQL (with a non-UTC DB timezone), a fake SMTP server and a mock SES API. They cover auth and CSRF, account limits, ownership isolation, admins being unable to create campaigns, sending, bounces, UNKNOWN handling, tracking, one-click unsubscribe, follow-up threading, the 7-campaign limit, the shared limiter, admin pause, emergency stop, monitoring and SES.
- **3 DB-guarantee tests**: concurrent workers can never exceed a shared account quota, crash recovery (STARTED→UNKNOWN, none→PENDING, ACCEPTED→SENT), and exactly one scheduler winning.
- **Browser smoke test** (headless Chrome): all 9 admin and 11 employee pages, campaign detail, the follow-up modal, session restore on reload, and **backend-down → "Connecting…" → automatic recovery**.
- Migrations verified identical to `schema.prisma` (pg_dump comparison). CI re-checks this with `prisma migrate diff --exit-code`.

## Merging into an existing repo

If `abacco-crm` already has `User`, `EmailAccount` or `Campaign` tables:

1. Compare its `schema.prisma` with `backend/prisma/schema.prisma` and **extend the existing models** with the fields used here, instead of adding duplicate tables.
2. Generate a migration against the existing database with `prisma migrate dev --create-only` in a **development branch of the database** (Neon branches are free), review the SQL, then deploy.
3. Port the `worker/`, `services/transports.js`, `services/smtpPhase.js` and `worker/quota.js` modules. They depend only on the fields listed in the schema.
