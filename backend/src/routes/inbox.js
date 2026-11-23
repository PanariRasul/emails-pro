// Employee inbox (campaign replies), employee dashboard/reports, sending history and notifications.
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { caches } from "../lib/cache.js";
import { ah, notFound } from "../lib/errors.js";
import { idParam, pagination, validate } from "../middleware/common.js";
import { employeeOnly, requireAuth } from "../middleware/auth.js";
import { getSettings } from "../services/settings.js";
import {
  accountLimits,
  dayWindow,
  employeeLimits,
} from "../services/limits.js";
import { WORKING_STATUSES, statsFor } from "../services/campaigns.js";
import { workerState } from "../worker/index.js";
import { config, trackingReachable } from "../config/index.js";
import { syncAccount } from "../services/imap.js";
import {
  buildVars,
  htmlToText,
  makeMessageId,
  renderTemplate,
  sanitizeEmailHtml,
  senderNameFor,
} from "../services/template.js";
import { deliver } from "../services/transports.js";
import { audit } from "../services/audit.js";
import { badRequest, conflict } from "../lib/errors.js";
import { invalidateOwner } from "../lib/cache.js";
import { logger } from "../lib/logger.js";
import { rateLimit } from "../lib/rateLimit.js";

// ======================= Inbox =======================
export const inboxRouter = Router();
inboxRouter.use(employeeOnly);

inboxRouter.get(
  "/",
  validate({
    query: pagination.extend({
      unread: z.enum(["true", "false"]).optional(),
      bounces: z.enum(["true", "false"]).optional(),
      spam: z.enum(["true", "false"]).optional(),
      search: z.string().trim().max(200).optional(),
      lead: z.enum(["interested", "none"]).optional(),
    }),
  }),
  ah(async (req, res) => {
    const { page, pageSize, unread, bounces, spam, search, lead } = req.query;
    let leadIds = null;
    if (lead === "interested") {
      leadIds = (
        await prisma.campaignRecipient.findMany({
          where: {
            campaign: { ownerId: req.user.id },
            leadStatus: { in: ["INTERESTED", "MEETING"] },
          },
          select: { id: true },
          take: 5000,
        })
      ).map((r) => r.id);
    }
    const where = {
      ...(leadIds ? { recipientId: { in: leadIds } } : {}),
      ownerId: req.user.id,
      direction: "INBOUND",
      deletedAt: null,
      ...(unread === "true" ? { isRead: false } : {}),
      ...(spam === "true"
        ? { folder: "SPAM" }
        : { isBounce: bounces === "true" }),
      ...(search
        ? {
            OR: [
              { fromAddr: { contains: search.toLowerCase() } },
              { subject: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [items, total, unreadCount] = await Promise.all([
      prisma.emailMessage.findMany({
        where,
        select: {
          id: true,
          fromAddr: true,
          toAddr: true,
          subject: true,
          receivedAt: true,
          isRead: true,
          isBounce: true,
          isAutoReply: true,
          folder: true,
          campaignId: true,
          recipientId: true,
          text: true,
          account: { select: { email: true } },
        },
        orderBy: { receivedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.emailMessage.count({ where }),
      prisma.emailMessage.count({
        where: {
          ownerId: req.user.id,
          direction: "INBOUND",
          isRead: false,
          isBounce: false,
          deletedAt: null,
        },
      }),
    ]);
    const recIds = [
      ...new Set(items.map((i) => i.recipientId).filter(Boolean)),
    ];
    const leads = new Map(
      (recIds.length
        ? await prisma.campaignRecipient.findMany({
            where: { id: { in: recIds } },
            select: { id: true, leadStatus: true },
          })
        : []
      ).map((r) => [r.id, r.leadStatus]),
    );
    const campaignIds = [
      ...new Set(items.map((i) => i.campaignId).filter(Boolean)),
    ];
    const names = new Map(
      (
        await prisma.campaign.findMany({
          where: { id: { in: campaignIds } },
          select: { id: true, name: true },
        })
      ).map((c) => [c.id, c.name]),
    );
    res.json({
      items: items.map((i) => ({
        ...i,
        snippet: replySnippet(i.text),
        text: undefined,
        campaignName: names.get(i.campaignId) || null,
        leadStatus: leads.get(i.recipientId) || null,
      })),
      total,
      page,
      pageSize,
      unread: unreadCount,
    });
  }),
);

/** First lines of the reply only (without the quoted original). */
function replySnippet(text) {
  const lines = String(text || "").split(/\r?\n/);
  const cut = lines.findIndex(
    (l) =>
      /^\s*>/.test(l) ||
      /^On\b.{3,200}\bwrote:\s*$/.test(l.trim()) ||
      /^-{2,}\s*Original Message/i.test(l.trim()) ||
      /^From:\s/.test(l.trim()),
  );
  return (cut === -1 ? lines : lines.slice(0, cut))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

// Manual "Check now": sync this employee's mailboxes immediately (bounded so the request stays fast).
inboxRouter.post(
  "/sync",
  rateLimit({
    name: "inbox-sync",
    max: 6,
    windowSec: 60,
    key: (req) => req.user.id,
  }),
  ah(async (req, res) => {
    const accounts = await prisma.emailAccount.findMany({
      where: {
        ownerId: req.user.id,
        deletedAt: null,
        adminDisabled: false,
        imapHost: { not: null },
        status: { in: ["CONNECTED", "PAUSED"] },
      },
      orderBy: { imapLastSyncAt: { sort: "asc", nulls: "first" } },
      take: 10,
    });
    const started = Date.now();
    const result = {
      accounts: accounts.length,
      checked: 0,
      replies: 0,
      bounces: 0,
      errors: [],
    };
    for (const account of accounts) {
      if (Date.now() - started > 25_000) break; // keep the request short; the worker continues the rest
      try {
        const r = await syncAccount(account);
        result.checked += 1;
        result.replies += r.replies || 0;
        result.bounces += r.bounces || 0;
      } catch (err) {
        logger.warn(
          { accountId: account.id, err: err.message },
          "manual imap sync failed",
        );
        result.errors.push({
          email: account.email,
          error: String(err.responseText || err.message).slice(0, 160),
        });
        await prisma.emailAccount.update({
          where: { id: account.id },
          data: {
            imapOk: false,
            lastError: `IMAP: ${String(err.responseText || err.message).slice(0, 200)}`,
          },
        });
      }
    }
    // Remaining mailboxes are picked up by the background worker right away.
    await prisma.emailAccount.updateMany({
      where: { ownerId: req.user.id, deletedAt: null, imapHost: { not: null } },
      data: { imapNextSyncAt: new Date() },
    });
    invalidateOwner(req.user.id);
    res.json(result);
  }),
);

inboxRouter.get(
  "/:id",
  validate({ params: idParam }),
  ah(async (req, res) => {
    const msg = await prisma.emailMessage.findFirst({
      where: { id: req.params.id, ownerId: req.user.id, deletedAt: null },
      include: { account: { select: { email: true, displayName: true } } },
    });
    if (!msg) throw notFound("Message");
    if (!msg.isRead)
      await prisma.emailMessage.update({
        where: { id: msg.id },
        data: { isRead: true },
      });
    const campaign = msg.campaignId
      ? await prisma.campaign.findUnique({
          where: { id: msg.campaignId },
          select: { id: true, name: true },
        })
      : null;
    const lead = msg.recipientId
      ? await prisma.campaignRecipient.findUnique({
          where: { id: msg.recipientId },
          select: { leadStatus: true, leadStatusAt: true },
        })
      : null;
    // The whole conversation with this recipient: what we sent (all campaigns/follow-ups) and every reply.
    let thread = [];
    if (msg.recipientId) {
      const rec = await prisma.campaignRecipient.findUnique({
        where: { id: msg.recipientId },
        select: { email: true, campaign: { select: { ownerId: true } } },
      });
      if (rec && rec.campaign.ownerId === req.user.id) {
        const [sent, replies] = await Promise.all([
          prisma.campaignRecipient.findMany({
            where: {
              email: rec.email,
              campaign: { ownerId: req.user.id },
              sentAt: { not: null },
            },
            select: {
              id: true,
              email: true,
              vars: true,
              sentAt: true,
              subject: true,
              status: true,
              openedAt: true,
              clickedAt: true,
              campaign: {
                select: { id: true, name: true, subject: true, type: true },
              },
              account: { select: { email: true, displayName: true } },
            },
            orderBy: { sentAt: "asc" },
            take: 20,
          }),
          prisma.emailMessage.findMany({
            where: {
              ownerId: req.user.id,
              deletedAt: null,
              OR: [
                { fromAddr: rec.email },
                { recipientId: msg.recipientId },
                { toAddr: rec.email, direction: "OUTBOUND" },
              ],
            },
            select: {
              id: true,
              receivedAt: true,
              subject: true,
              isBounce: true,
              isAutoReply: true,
              folder: true,
              fromAddr: true,
              direction: true,
              text: true,
            },
            orderBy: { receivedAt: "asc" },
            take: 50,
          }),
        ]);
        thread = [
          // Show the subject exactly as the person received it (variables filled in).
          ...sent.map((x) => ({
            kind: "SENT",
            at: x.sentAt,
            subject: renderTemplate(
              x.subject || x.campaign.subject,
              buildVars({ recipient: x, owner: req.user, account: x.account }),
            ),
            campaign: x.campaign,
            from: x.account?.email,
            status: x.status,
            openedAt: x.openedAt,
            clickedAt: x.clickedAt,
          })),
          ...replies.map((x) =>
            x.direction === "OUTBOUND"
              ? {
                  kind: "YOU_REPLIED",
                  at: x.receivedAt,
                  subject: x.subject,
                  id: x.id,
                  text: (x.text || "").slice(0, 2000),
                  from: x.fromAddr,
                }
              : {
                  kind: x.isBounce
                    ? "BOUNCE"
                    : x.isAutoReply
                      ? "AUTO"
                      : "REPLY",
                  at: x.receivedAt,
                  subject: x.subject,
                  id: x.id,
                  folder: x.folder,
                  current: x.id === msg.id,
                },
          ),
        ].sort((a, b) => new Date(a.at) - new Date(b.at));
      }
    }
    res.json({
      message: { ...msg, isRead: true },
      campaign,
      thread,
      leadStatus: lead?.leadStatus || null,
      sanitized: true,
    });
  }),
);

const LEADS = [
  "INTERESTED",
  "MEETING",
  "NOT_INTERESTED",
  "WRONG_PERSON",
  "OUT_OF_OFFICE",
  "OTHER",
];

// Mark what the person answered (Interested, Meeting, Not interested …). Used for response tracking per pitch.
inboxRouter.post(
  "/:id/status",
  validate({
    params: idParam,
    body: z.object({ leadStatus: z.enum(LEADS).nullable() }),
  }),
  ah(async (req, res) => {
    const msg = await prisma.emailMessage.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
      select: { recipientId: true },
    });
    if (!msg?.recipientId) throw notFound("Message");
    const r = await prisma.campaignRecipient.updateMany({
      where: { id: msg.recipientId, campaign: { ownerId: req.user.id } },
      data: {
        leadStatus: req.body.leadStatus,
        leadStatusAt: req.body.leadStatus ? new Date() : null,
      },
    });
    invalidateOwner(req.user.id);
    res.json({ updated: r.count, leadStatus: req.body.leadStatus });
  }),
);

/**
 * Reply from inside Emails Pro: sent from the SAME mailbox that received the reply, in the same thread
 * (In-Reply-To / References), and counted in that mailbox's daily usage.
 */
inboxRouter.post(
  "/:id/reply",
  rateLimit({
    name: "inbox-reply",
    max: 20,
    windowSec: 60,
    key: (req) => req.user.id,
  }),
  validate({
    params: idParam,
    body: z.object({
      html: z.string().min(1).max(100_000),
      subject: z.string().trim().max(250).optional(),
    }),
  }),
  ah(async (req, res) => {
    const msg = await prisma.emailMessage.findFirst({
      where: {
        id: req.params.id,
        ownerId: req.user.id,
        direction: "INBOUND",
        deletedAt: null,
      },
      include: { account: true },
    });
    if (!msg) throw notFound("Message");
    if (msg.isBounce)
      throw badRequest(
        "This is a delivery-failure notice — there is no one to reply to.",
      );
    const acc = msg.account;
    if (acc.deletedAt || acc.adminDisabled || acc.status !== "CONNECTED")
      throw conflict(
        `${acc.email} is not connected. Reconnect it on the Accounts page, then reply.`,
      );
    const settings = await getSettings();
    if (settings.globalSendingPaused)
      throw conflict("Sending is paused by your administrator.");
    if (req.user.sendingDisabled)
      throw conflict("Sending is disabled for your account.");
    const html = sanitizeEmailHtml(req.body.html);
    const text = htmlToText(html);
    if (!text.trim()) throw badRequest("Write a reply first");

    // Count it against the mailbox's and the employee's daily limits (replies are 1:1, so no pacing slot).
    const lim = accountLimits(acc, req.user, settings);
    const day = dayWindow();
    const bump = async (scope, limit) =>
      (
        await prisma.$queryRaw`
    INSERT INTO "UsageCounter" ("scope", "windowStart", "count") VALUES (${scope}, ${day}, 1)
    ON CONFLICT ("scope", "windowStart") DO UPDATE SET "count" = "UsageCounter"."count" + 1
    WHERE "UsageCounter"."count" < ${limit} RETURNING "count"`
      ).length > 0;
    if (!(await bump(`acct:${acc.id}:day`, lim.daily)))
      throw conflict(
        `${acc.email} has reached today's sending limit (${lim.daily}).`,
      );
    if (!(await bump(`emp:${req.user.id}:day`, lim.employeeDaily)))
      throw conflict(
        `You have reached today's sending limit (${lim.employeeDaily}).`,
      );

    const subject =
      req.body.subject ||
      (/^re:/i.test(msg.subject || "")
        ? msg.subject
        : `Re: ${msg.subject || ""}`.trim());
    const references = [
      ...String(msg.references || "")
        .split(/\s+/)
        .filter(Boolean),
      msg.messageId,
    ]
      .slice(-20)
      .join(" ");
    const sender = senderNameFor(acc, req.user);
    const messageId = makeMessageId(acc.email);
    const wrapped = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1f2937">${html}</div>`;
    let info;
    try {
      info = await deliver(acc, {
        from: { name: sender, address: acc.email },
        to: msg.fromAddr,
        subject,
        html: wrapped,
        text,
        messageId,
        inReplyTo: msg.messageId,
        references,
      });
    } catch (err) {
      await prisma.$executeRaw`UPDATE "UsageCounter" SET "count" = GREATEST(0, "count" - 1) WHERE "windowStart" = ${day} AND "scope" IN (${`acct:${acc.id}:day`}, ${`emp:${req.user.id}:day`})`;
      logger.warn(
        { accountId: acc.id, err: err.message },
        "inbox reply failed",
      );
      throw conflict(
        `Could not send from ${acc.email}: ${String(err.responseText || err.response || err.message).slice(0, 200)}`,
      );
    }
    const sent = await prisma.emailMessage.create({
      data: {
        ownerId: req.user.id,
        accountId: acc.id,
        recipientId: msg.recipientId,
        campaignId: msg.campaignId,
        direction: "OUTBOUND",
        messageId: info?.messageId || messageId,
        inReplyTo: msg.messageId,
        references,
        fromAddr: acc.email,
        toAddr: msg.fromAddr,
        subject,
        text,
        html: wrapped,
        isRead: true,
        receivedAt: new Date(),
      },
    });
    audit(req, "inbox.replied", "EmailMessage", msg.id, {
      to: msg.fromAddr,
      from: acc.email,
    });
    invalidateOwner(req.user.id);
    res
      .status(201)
      .json({ message: { id: sent.id, subject, at: sent.receivedAt } });
  }),
);

inboxRouter.post(
  "/read-all",
  ah(async (req, res) => {
    const r = await prisma.emailMessage.updateMany({
      where: { ownerId: req.user.id, isRead: false, deletedAt: null },
      data: { isRead: true },
    });
    res.json({ updated: r.count });
  }),
);

// Delete = hide from the inbox. The record is kept (marked deleted) so the next sync never brings it back,
// and the recipient stays marked as replied/bounced so follow-ups still exclude them.
inboxRouter.post(
  "/delete",
  validate({
    body: z.object({ ids: z.array(z.string().max(40)).min(1).max(500) }),
  }),
  ah(async (req, res) => {
    const r = await prisma.emailMessage.updateMany({
      where: {
        id: { in: req.body.ids },
        ownerId: req.user.id,
        deletedAt: null,
      },
      data: { deletedAt: new Date(), isRead: true },
    });
    invalidateOwner(req.user.id);
    res.json({ deleted: r.count });
  }),
);

inboxRouter.delete(
  "/:id",
  validate({ params: idParam }),
  ah(async (req, res) => {
    const r = await prisma.emailMessage.updateMany({
      where: { id: req.params.id, ownerId: req.user.id, deletedAt: null },
      data: { deletedAt: new Date(), isRead: true },
    });
    if (!r.count) throw notFound("Message");
    invalidateOwner(req.user.id);
    res.json({ deleted: r.count });
  }),
);

// ======================= Employee reports =======================
export const reportsRouter = Router();
reportsRouter.use(employeeOnly);

reportsRouter.get(
  "/dashboard",
  ah(async (req, res) => {
    const uid = req.user.id;
    const data = await caches.dashboard.wrap(
      `emp:${uid}:dashboard`,
      async () => {
        const settings = await getSettings();
        const limits = employeeLimits(req.user, settings);
        const since30 = new Date(Date.now() - 30 * 86_400_000);
        const [
          accounts,
          working,
          sentTodayRow,
          totals,
          unread,
          recent,
          worker,
        ] = await Promise.all([
          prisma.emailAccount.groupBy({
            by: ["status"],
            where: { ownerId: uid, deletedAt: null },
            _count: { _all: true },
          }),
          prisma.campaign.count({
            where: {
              ownerId: uid,
              archived: false,
              status: { in: WORKING_STATUSES },
            },
          }),
          prisma.usageCounter.findUnique({
            where: {
              scope_windowStart: {
                scope: `emp:${uid}:day`,
                windowStart: dayWindow(),
              },
            },
          }),
          prisma.$queryRaw`
        SELECT count(*) FILTER (WHERE r.status = 'SENT')::int AS sent,
               count(r."openedAt")::int AS opened, count(r."clickedAt")::int AS clicked,
               count(r."repliedAt")::int AS replied, count(*) FILTER (WHERE r.status = 'BOUNCED')::int AS bounced,
               count(*) FILTER (WHERE r.status = 'FAILED')::int AS failed, count(*) FILTER (WHERE r.status = 'UNKNOWN')::int AS unknown,
               count(*) FILTER (WHERE r.status = 'ON_HOLD')::int AS "onHold", count(r."unsubscribedAt")::int AS unsubscribed
        FROM "CampaignRecipient" r JOIN "Campaign" c ON c.id = r."campaignId"
        WHERE c."ownerId" = ${uid} AND (r."sentAt" >= ${since30} OR r.status::text IN ('UNKNOWN', 'ON_HOLD', 'FAILED') AND r."createdAt" >= ${since30})`,
          prisma.emailMessage.count({
            where: {
              ownerId: uid,
              direction: "INBOUND",
              isRead: false,
              isBounce: false,
              deletedAt: null,
            },
          }),
          prisma.campaign.findMany({
            where: { ownerId: uid, archived: false },
            orderBy: { createdAt: "desc" },
            take: 6,
            select: {
              id: true,
              name: true,
              status: true,
              type: true,
              scheduledAt: true,
              startedAt: true,
              pausedReason: true,
            },
          }),
          Promise.resolve(workerState()),
        ]);
        const stats = await statsFor(recent.map((c) => c.id));
        // Getting-started checklist for new employees.
        const [contacts, pitches, started, handled] = await Promise.all([
          prisma.contact.count({ where: { list: { ownerId: uid } } }),
          prisma.pitch.count({ where: { ownerId: uid, archived: false } }),
          prisma.campaign.count({
            where: { ownerId: uid, startedAt: { not: null } },
          }),
          prisma.emailMessage
            .count({ where: { ownerId: uid, direction: "OUTBOUND" } })
            .then(
              async (n) =>
                n ||
                prisma.campaignRecipient.count({
                  where: {
                    campaign: { ownerId: uid },
                    leadStatus: { not: null },
                  },
                }),
            ),
        ]);
        const accountCount = accounts.reduce((s, a) => s + a._count._all, 0);
        return {
          accounts: {
            total: accountCount,
            byStatus: Object.fromEntries(
              accounts.map((a) => [a.status, a._count._all]),
            ),
            limit: limits.accounts,
            remaining: Math.max(0, limits.accounts - accountCount),
          },
          campaigns: { working, limit: settings.maxWorkingCampaigns },
          quota: {
            sentToday: sentTodayRow?.count || 0,
            dailyLimit: limits.daily,
            hourlyPerAccount: limits.hourly,
          },
          last30Days: totals[0],
          unreadReplies: unread,
          setup: {
            account: accounts.length > 0,
            contacts: contacts > 0,
            pitch: pitches > 0,
            campaign: started > 0,
            reply: handled > 0,
          },
          recent: recent.map((c) => ({ ...c, stats: stats.get(c.id) })),
          sending: {
            globalPaused: settings.globalSendingPaused,
            disabled: req.user.sendingDisabled,
            workerLastTick: worker.lastTickAt,
          },
          tracking: {
            enabled: settings.trackingEnabled,
            reachable: trackingReachable(),
            url: config.publicApiUrl,
          },
        };
      },
      30_000,
    );
    res.json(data);
  }),
);

reportsRouter.get(
  "/analytics",
  validate({
    query: z.object({
      days: z.coerce.number().int().min(1).max(90).default(30),
    }),
  }),
  ah(async (req, res) => {
    const since = new Date(Date.now() - req.query.days * 86_400_000);
    const key = `emp:${req.user.id}:analytics:${req.query.days}`;
    const data = await caches.stats.wrap(
      key,
      async () => {
        const daily = await prisma.$queryRaw`
      SELECT to_char(date_trunc('day', r."sentAt"), 'YYYY-MM-DD') AS day,
             count(*)::int AS sent, count(r."openedAt")::int AS opened, count(r."clickedAt")::int AS clicked,
             count(r."repliedAt")::int AS replied, count(*) FILTER (WHERE r.status = 'BOUNCED')::int AS bounced
      FROM "CampaignRecipient" r JOIN "Campaign" c ON c.id = r."campaignId"
      WHERE c."ownerId" = ${req.user.id} AND r."sentAt" >= ${since}
      GROUP BY 1 ORDER BY 1`;
        const byAccount = await prisma.$queryRaw`
      SELECT a.email, count(*)::int AS sent, count(r."repliedAt")::int AS replied,
             count(*) FILTER (WHERE r.status = 'BOUNCED')::int AS bounced
      FROM "CampaignRecipient" r JOIN "EmailAccount" a ON a.id = r."accountId"
      WHERE a."ownerId" = ${req.user.id} AND r."sentAt" >= ${since}
      GROUP BY a.email ORDER BY sent DESC LIMIT 50`;
        return { daily, byAccount };
      },
      60_000,
    );
    res.json({
      ...data,
      tracking: { reachable: trackingReachable(), url: config.publicApiUrl },
      note: "Opens and clicks are approximate: image blocking, privacy proxies and security scanners affect them.",
    });
  }),
);

/**
 * Response tracking: which pitches and subject lines get replies.
 * Counts first emails (fresh campaigns) and follow-ups separately. Out-of-office answers are not replies.
 */
reportsRouter.get(
  "/responses",
  validate({
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).default(90),
    }),
  }),
  ah(async (req, res) => {
    const since = new Date(Date.now() - req.query.days * 86_400_000);
    const uid = req.user.id;
    const [pitches, subjects, leads] = await Promise.all([
      prisma.$queryRaw`
      SELECT p."id", p."name", c."type"::text AS "type",
             count(*) FILTER (WHERE r."sentAt" IS NOT NULL)::int AS "sent",
             count(r."openedAt")::int AS "opened",
             count(r."repliedAt")::int AS "replied",
             count(*) FILTER (WHERE r."leadStatus" IN ('INTERESTED','MEETING'))::int AS "interested",
             count(*) FILTER (WHERE r."status" = 'BOUNCED')::int AS "bounced"
        FROM "CampaignRecipient" r
        JOIN "Campaign" c ON c."id" = r."campaignId"
        JOIN "PitchVersion" v ON v."id" = c."pitchVersionId"
        JOIN "Pitch" p ON p."id" = v."pitchId"
       WHERE c."ownerId" = ${uid} AND r."sentAt" >= ${since}
       GROUP BY p."id", p."name", c."type"
       ORDER BY "sent" DESC
       LIMIT 100`,
      prisma.$queryRaw`
      SELECT COALESCE(r."subject", c."subject") AS "subject",
             count(*)::int AS "sent",
             count(r."openedAt")::int AS "opened",
             count(r."repliedAt")::int AS "replied",
             count(*) FILTER (WHERE r."leadStatus" IN ('INTERESTED','MEETING'))::int AS "interested"
        FROM "CampaignRecipient" r
        JOIN "Campaign" c ON c."id" = r."campaignId"
       WHERE c."ownerId" = ${uid} AND c."type" = 'FRESH' AND r."sentAt" >= ${since}
       GROUP BY 1
      HAVING count(*) >= 1
       ORDER BY "sent" DESC
       LIMIT 50`,
      prisma.campaignRecipient.groupBy({
        by: ["leadStatus"],
        where: {
          campaign: { ownerId: uid },
          leadStatus: { not: null },
          leadStatusAt: { gte: since },
        },
        _count: { _all: true },
      }),
    ]);
    const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    res.json({
      days: req.query.days,
      pitches: pitches.map((p) => ({
        ...p,
        replyRate: rate(p.replied, p.sent),
        interestRate: rate(p.interested, p.sent),
      })),
      subjects: subjects.map((s) => ({
        ...s,
        replyRate: rate(s.replied, s.sent),
        openRate: rate(s.opened, s.sent),
      })),
      leads: Object.fromEntries(
        leads.map((l) => [l.leadStatus, l._count._all]),
      ),
      note: "Reply rate = people who replied ÷ emails sent. Out-of-office answers are not counted as replies. Subject lines with {{variables}} are shown as written.",
    });
  }),
);

reportsRouter.get(
  "/history",
  validate({
    query: pagination.extend({
      campaignId: z.string().max(40).optional(),
      status: z.string().max(20).optional(),
    }),
  }),
  ah(async (req, res) => {
    const { page, pageSize, campaignId, status } = req.query;
    const campaigns = await prisma.campaign.findMany({
      where: {
        ownerId: req.user.id,
        ...(campaignId ? { id: campaignId } : {}),
      },
      select: { id: true, name: true },
    });
    const names = new Map(campaigns.map((c) => [c.id, c.name]));
    const where = {
      campaignId: { in: [...names.keys()] },
      ...(status ? { status } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.sendAttempt.findMany({
        where,
        select: {
          id: true,
          campaignId: true,
          accountId: true,
          attemptNo: true,
          status: true,
          smtpCode: true,
          response: true,
          errorClass: true,
          startedAt: true,
          finishedAt: true,
          messageId: true,
          recipient: { select: { email: true, status: true } },
        },
        orderBy: { startedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.sendAttempt.count({ where }),
    ]);
    const accIds = [...new Set(items.map((i) => i.accountId))];
    const accs = new Map(
      (
        await prisma.emailAccount.findMany({
          where: { id: { in: accIds } },
          select: { id: true, email: true },
        })
      ).map((a) => [a.id, a.email]),
    );
    res.json({
      items: items.map((i) => ({
        ...i,
        campaignName: names.get(i.campaignId),
        accountEmail: accs.get(i.accountId),
      })),
      total,
      page,
      pageSize,
    });
  }),
);

// ======================= Notifications =======================
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

const notifWhere = (user) =>
  user.role === "ADMIN"
    ? { OR: [{ forAdmins: true }, { userId: user.id }] }
    : { userId: user.id };

notificationsRouter.get(
  "/",
  ah(async (req, res) => {
    const where = notifWhere(req.user);
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
      prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    res.json({ items, unread });
  }),
);

notificationsRouter.post(
  "/read",
  validate({
    body: z.object({ ids: z.array(z.string().max(40)).max(100).optional() }),
  }),
  ah(async (req, res) => {
    const where = {
      ...notifWhere(req.user),
      readAt: null,
      ...(req.body.ids ? { id: { in: req.body.ids } } : {}),
    };
    const r = await prisma.notification.updateMany({
      where,
      data: { readAt: new Date() },
    });
    res.json({ updated: r.count });
  }),
);
