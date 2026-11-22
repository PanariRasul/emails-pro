# Free-tier limitations (read before relying on Emails Pro)

Emails Pro is engineered to behave correctly on free hosting. It **cannot remove the limits of the hosting itself**. Plan around them honestly. Figures were checked in November 2026; providers change them, so re-check their pricing pages.

## Render Free Web Service (API + worker)

| Limit | Effect on Emails Pro | Mitigation in the app |
|---|---|---|
| **Spins down after 15 min with no inbound traffic**; restarting takes about a minute | Sending, scheduled starts and IMAP sync **pause while asleep**. The first page load after idle is slow. | The frontend shows "Connecting to Emails Pro…" and retries. The worker resumes on wake, starts overdue campaigns once, and reports the gap on *System health*. **No artificial keep-alive pings** (against the brief and the spirit of the free plan). |
| **750 free instance hours per workspace per month** | One always-busy service uses about 720 h. Running a second free service in the same workspace can exhaust the hours. | Keep only one free web service. The static site doesn't use instance hours. |
| **Outbound SMTP ports 25, 465, 587 blocked** | Zoho, Yahoo, Rediffmail and most SMTP accounts **cannot send** from a free instance. | Gmail/Workspace via **Gmail API**, **Amazon SES API**, or **port 2525** relays. Otherwise use a paid instance. The UI explains this when it happens. |
| **No background-worker service type** | The worker must share the web process. | In-process worker with a DB lease. Splitting it out later is a config change (`RUN_WORKER=false` on the API plus a worker service). |
| **No persistent disk; about 512 MB RAM** | Nothing is stored on local disk. | All state lives in Postgres. Memory measured at about 180 MB RSS, with a 384 MB heap cap. |

**What this means in practice:** a campaign started while someone is using the app sends normally. If everyone closes the app, the service sleeps about 15 minutes later and **sending pauses until the next visit or inbound request** (e.g. someone opening the dashboard, an open-pixel or click hit). Tracking and unsubscribe links hitting the API also wake it. For unattended 24/7 sending, upgrade the API service to a paid instance. No code changes are needed.

## Neon Free PostgreSQL

| Limit | Effect | Mitigation |
|---|---|---|
| **Compute scales to zero after 5 min idle** | First query after idle takes a few seconds | Connection timeout 20 s, retries with backoff and jitter, `503 + Retry-After` → frontend retry |
| **100 CU-hours per project per month** | A 0.25 CU compute running constantly would use about 180 CU-h, but scale-to-zero plus Render's own sleep keep usage far lower | The worker uses long idle ticks (60 s) when nothing is sending, and no polling at all while asleep |
| **1 GB storage per project** | Roughly a few hundred thousand recipient rows plus replies | Only campaign replies/bounces stored, bodies capped, operational tables pruned, contact cap of 100k per employee |
| **Connection limits** (pooler accepts many clients; direct connections are capped) | – | App uses the pooled URL with 5 connections; migrations use the direct URL |

## Email providers (independent of hosting)

- Gmail consumer accounts have provider-side daily sending caps, and Workspace has higher ones. Emails Pro's limits sit **on top of** provider limits. Set account caps at or below them.
- **Amazon SES** starts in a sandbox (verified recipients only, low quota) until you request production access.
- Opens and clicks are **approximate** (image blocking, Apple Mail Privacy Protection, link scanners). The app labels them that way and flags probable scanner clicks.
- No system can guarantee inbox placement. Authentication (SPF, DKIM, DMARC), permission-based lists and sensible pacing are what help.
- Gmail and Yahoo bulk-sender rules require one-click unsubscribe for marketing mail at volume. Emails Pro always adds RFC 8058 headers and a footer link, and the admin can restyle but not remove them.

## Not available on the free stack

- Guaranteed scheduled send times while the service is asleep
- 24/7 IMAP reply monitoring
- SMTP on 465/587 (Zoho, Yahoo, Rediffmail, most custom servers)
- A separate always-on worker process

## Login OTP / password-reset email on Render Free
Render Free blocks outbound SMTP ports (25/465/587). A Gmail **app password** (`SYSTEM_MAIL_APP_PASSWORD`) therefore can't deliver codes there. Use **Admin → Policies & settings → Login security → Connect with Google** instead, which sends through the Gmail API over HTTPS. The app-password route works locally and on paid instances. Gmail's own daily sending limits apply to the OTP mailbox.
