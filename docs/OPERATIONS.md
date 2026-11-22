# Operations runbook

## How sending works (and why it is safe across restarts)

1. An employee starts a campaign → status `SENDING` (or `SCHEDULED` / `PENDING_APPROVAL`). The API never sends from a request handler; it only wakes the worker.
2. The worker (one leader per deployment, elected through the `WorkerLease` row) claims **one recipient at a time** per campaign with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`.
3. It reserves an account slot **atomically** in one transaction:
   - the account's shared pacing slot (`EmailAccount.nextSendAt`), which is shared by **all** campaigns on that account,
   - the hourly, daily and employee-daily counters (`UsageCounter`, conditional upsert `WHERE count < limit`).
4. It writes a `SendAttempt` row with a unique idempotency key **before** contacting the provider.
5. After the provider accepts the message, it records `SENT` together with the Message-ID that was actually used.
6. Failures:

| Class | Example | Action |
|---|---|---|
| TRANSIENT | 421, 4xx, connection refused **before DATA** | retry with exponential backoff + jitter (max retries from settings) |
| THROTTLED | 451 rate limit, Gmail 429, SES TooManyRequests | defer the account to the next window, no attempt consumed |
| AUTH | 535, expired OAuth | account → `ERROR`, employee + admins notified, recipient re-queued |
| INVALID_RECIPIENT | 550 5.1.1 | `BOUNCED` + org-wide suppression |
| PERMANENT | 554 policy | `FAILED`, never auto-retried |
| UNCERTAIN | connection lost **after DATA**, HTTP timeout | `UNKNOWN`, never resent automatically |

7. **Recovery** (on every wake and every 2 minutes): recipients stuck in `SENDING` become `SENT` (if the attempt was accepted), `UNKNOWN` (if the attempt started) or `PENDING` (if the provider was never contacted).
8. **Reconciliation**: for `UNKNOWN` sends on accounts with IMAP, the worker searches the Sent folder for the exact Message-ID. If found → `SENT`. Otherwise the employee decides (*Mark sent* / *Mark failed* / *Retry anyway*).

## Routine tasks

### Database migrations
- Change `backend/prisma/schema.prisma` locally, then run `npx prisma migrate dev --name <change>` **against a development database** (e.g. a Neon branch, never production).
- Commit the generated `prisma/migrations/*` folder. Render applies it on the next deploy with `prisma migrate deploy`.
- Never run `prisma migrate dev` or `prisma migrate reset` against production.
- CI fails if the migrations and `schema.prisma` drift apart.

### Backups
- Neon keeps restore history (point-in-time) within the plan's window. Before risky changes, create a **branch** (instant copy) in the Neon console.
- For an off-site copy: `pg_dump "$DIRECT_URL" -Fc -f emailspro-$(date +%F).dump`.

### Rotating the encryption key
1. Set `ENCRYPTION_KEY_PREVIOUS` = the current key and `ENCRYPTION_KEY` = a new key (`openssl rand -base64 32`). Deploy.
2. Existing secrets stay readable through the previous key. New and updated credentials use the new key. Ask employees to *Reconnect* accounts (or re-save) to re-encrypt.
3. Once every account has been re-saved, remove `ENCRYPTION_KEY_PREVIOUS`.

### Emergency controls (Admin)
- **Emergency stop** (dashboard): stops all sending instantly. Campaigns stay intact and resume when re-enabled.
- **Stop sending** for one employee (Employee → *Stop sending*).
- **Disable** one account (SMTP monitoring → *Disable*).
- **Pause** a campaign (Campaign monitoring). Employees cannot resume an admin-paused campaign until the admin releases the hold.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Connecting to Emails Pro…" for about a minute | Render service or Neon waking | Normal on the free plan |
| Account test: "cannot reach SMTP port 465/587" | Render Free SMTP block | Use Google sign-in, SES API, port 2525 relay, or a paid instance |
| Campaign "sending" but nothing goes out | quota reached, warm-up cap, account paused, service asleep | Campaign page shows the reason. *System health* → stalled campaigns |
| Many `UNKNOWN` | network drops during sends | Review on the campaign page. Enable IMAP for automatic reconciliation |
| Replies not detected | IMAP not configured/failing, or service asleep | Account page shows IMAP status and last sync time |
| `DB_UNAVAILABLE` errors | Neon cold start or outage | Client retries automatically. Check Neon status if persistent |
| OAuth "did not return a refresh token" | Google consent already granted | Remove the app at myaccount.google.com/permissions and connect again |

## Logs
Structured JSON logs (pino) appear in Render → Logs. Each send logs `campaignId`, `employeeId`, `accountId` and `recipientId`. Passwords, tokens and encrypted secrets are redacted.

---

## Pre-launch test checklist

Brief §10 (hosting) and plan §19 (business rules). ✅ = automated test exists (CI). 🖐 = manual check on the deployed stack.

| # | Test | Coverage |
|---|---|---|
| 1 | Frontend loads from Render | 🖐 open the static URL |
| 2 | Backend starts correctly | ✅ e2e `health and readiness`; 🖐 `/health` |
| 3 | Neon connection works | 🖐 `/ready` shows database ok |
| 4 | Prisma queries work after Neon cold start | 🖐 wait more than 5 min idle, reload the dashboard |
| 5 | Login + refresh authentication | ✅ e2e refresh rotation + CSRF; browser reload test |
| 6 | Campaign data loads without excessive queries | ✅ aggregate stats are one SQL per page; cached 15–30 s |
| 7 | Frontend handles backend sleep | ✅ browser test (API stopped → banner → recovery) |
| 8 | Backend recovers after restart | ✅ recovery tests; 🖐 *Manual Deploy* mid-campaign |
| 9 | Caches rebuild correctly | ✅ caches are disposable/TTL; restart test |
| 10 | Cache invalidation works | ✅ e2e (limit change takes effect immediately) |
| 11 | SMTP connections not duplicated | ✅ one pooled transport per account, bounded, idle-closed |
| 12 | Worker restart → no duplicate sends | ✅ recovery test (STARTED → UNKNOWN) |
| 13 | Scheduled campaigns recover | ✅ scheduler exactly-once test |
| 14 | IMAP sync resumes safely | ✅ UID-based incremental sync with UIDVALIDITY check; 🖐 reply to a test email |
| 15 | Memory within Render limits | 🖐 *System health* → RSS (about 180 MB measured) |
| 16 | Migrations preserve data | ✅ `migrate deploy` only; CI drift check |
| – | Account limit reached → blocked; admin raises → allowed | ✅ e2e |
| – | Employee 1 cannot access Employee 2's account | ✅ e2e |
| – | Two campaigns share an account → combined rate within limit | ✅ DB concurrency test + e2e pacing |
| – | 8th working campaign blocked | ✅ e2e |
| – | Admin cannot create campaigns | ✅ e2e (403) |
| – | SMTP auth failure → account paused + admin notified | ✅ classifier unit test; 🖐 change a password |
| – | Unsubscribe → future sends blocked | ✅ e2e one-click unsubscribe |
| – | Hard bounce → suppressed | ✅ e2e (550 5.1.1) |
| – | Campaign paused → sends stop | ✅ e2e admin pause |
| – | Original account disconnected → follow-up held, not switched | ✅ sender logic; 🖐 disconnect an account mid follow-up |
| – | Uncertain outcome → UNKNOWN | ✅ e2e (connection dropped after DATA) |
| – | Provider tests (Gmail, Workspace, Zoho, Yahoo, Rediffmail, SES, custom) | 🖐 with permission-based test lists |
