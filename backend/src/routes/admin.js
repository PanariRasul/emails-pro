// Admin: employees, policies, account limits, monitoring, approvals, emergency controls, audit.
// Admins can pause/approve but can NEVER create, start or send campaigns.
import { Router } from "express";
import { aiStatus } from "../services/ai.js";
import { z } from "zod";
import { prisma, pingDb } from "../lib/prisma.js";
import { caches, cacheStats, invalidateOwner } from "../lib/cache.js";
import { ah, badRequest, conflict, notFound } from "../lib/errors.js";
import { idParam, pagination, validate } from "../middleware/common.js";
import { adminOnly, invalidateUser } from "../middleware/auth.js";
import { audit, notify } from "../services/audit.js";
import { getSettings, updateSettings } from "../services/settings.js";
import { dayWindow, employeeLimits } from "../services/limits.js";
import { WORKING_STATUSES, statsFor } from "../services/campaigns.js";
import { closeTransport, transportCount } from "../services/smtp.js";
import { smtpEgress } from "../services/egress.js";
import { redisConfigured, pingRedis } from "../lib/redis.js";
import { workerState, wakeWorker } from "../worker/index.js";
import { processStats } from "../worker/health.js";
import { ACCOUNT_PUBLIC, decorateAccounts } from "./accounts.js";
import { hashPassword } from "./auth.js";
import { config } from "../config/index.js";
import { rateLimit } from "../lib/rateLimit.js";
import {
  codeEmail,
  sendSystemMail,
  systemMailStatus,
} from "../services/systemMail.js";
import { googleAuthUrl, googleOAuthEnabled } from "../services/oauth.js";

const router = Router();
router.use(adminOnly);

// ---------- dashboard ----------
router.get(
  "/dashboard",
  ah(async (_req, res) => {
    const data = await caches.dashboard.wrap(
      "admin:dashboard",
      async () => {
        const since24 = new Date(Date.now() - 86_400_000);
        const [
          employees,
          accounts,
          campaigns,
          sent24,
          bounced24,
          unknown,
          pendingApproval,
          settings,
        ] = await Promise.all([
          prisma.user.groupBy({
            by: ["isActive"],
            where: { role: "EMPLOYEE" },
            _count: { _all: true },
          }),
          prisma.emailAccount.groupBy({
            by: ["status"],
            where: { deletedAt: null },
            _count: { _all: true },
          }),
          prisma.campaign.groupBy({
            by: ["status"],
            where: { archived: false },
            _count: { _all: true },
          }),
          prisma.campaignRecipient.count({
            where: { sentAt: { gte: since24 } },
          }),
          prisma.campaignRecipient.count({
            where: { bouncedAt: { gte: since24 } },
          }),
          prisma.campaignRecipient.count({ where: { status: "UNKNOWN" } }),
          prisma.campaign.count({ where: { status: "PENDING_APPROVAL" } }),
          getSettings(),
        ]);
        const map = (rows, k) =>
          Object.fromEntries(rows.map((r) => [String(r[k]), r._count._all]));
        return {
          employees: map(employees, "isActive"),
          accounts: map(accounts, "status"),
          campaigns: map(campaigns, "status"),
          last24h: { sent: sent24, bounced: bounced24 },
          unknownSends: unknown,
          pendingApproval,
          globalSendingPaused: settings.globalSendingPaused,
          worker: workerState(),
        };
      },
      30_000,
    );
    res.json(data);
  }),
);

// ---------- employees ----------
const limitField = z.coerce
  .number()
  .int()
  .min(0)
  .max(100_000)
  .nullable()
  .optional();

router.get(
  "/employees",
  validate({
    query: pagination.extend({ search: z.string().max(200).optional() }),
  }),
  ah(async (req, res) => {
    const { page, pageSize, search } = req.query;
    const settings = await getSettings();
    const where = {
      role: "EMPLOYEE",
      ...(search
        ? {
            OR: [
              { email: { contains: search.toLowerCase() } },
              { name: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          sendingDisabled: true,
          accountLimit: true,
          dailyLimit: true,
          hourlyLimit: true,
          requireApproval: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
      prisma.user.count({ where }),
    ]);
    const ids = users.map((u) => u.id);
    const [acc, camp, sent] = await Promise.all([
      prisma.emailAccount.groupBy({
        by: ["ownerId"],
        where: { ownerId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.campaign.groupBy({
        by: ["ownerId"],
        where: {
          ownerId: { in: ids },
          archived: false,
          status: { in: WORKING_STATUSES },
        },
        _count: { _all: true },
      }),
      prisma.usageCounter.findMany({
        where: {
          scope: { in: ids.map((id) => `emp:${id}:day`) },
          windowStart: dayWindow(),
        },
      }),
    ]);
    const accM = new Map(acc.map((a) => [a.ownerId, a._count._all]));
    const campM = new Map(camp.map((a) => [a.ownerId, a._count._all]));
    const sentM = new Map(sent.map((s) => [s.scope.split(":")[1], s.count]));
    res.json({
      items: users.map((u) => {
        const lim = employeeLimits(u, settings);
        return {
          ...u,
          effective: lim,
          accounts: accM.get(u.id) || 0,
          accountsRemaining: Math.max(0, lim.accounts - (accM.get(u.id) || 0)),
          workingCampaigns: campM.get(u.id) || 0,
          sentToday: sentM.get(u.id) || 0,
        };
      }),
      total,
      page,
      pageSize,
      defaults: {
        accountLimit: settings.defaultAccountLimit,
        dailyLimit: settings.defaultDailyLimit,
        hourlyLimit: settings.defaultHourlyLimit,
      },
    });
  }),
);

async function checkLimits(body) {
  const s = await getSettings();
  if (body.accountLimit != null && body.accountLimit > s.maxAccountLimit)
    throw badRequest(
      `Account limit can't exceed the system maximum (${s.maxAccountLimit})`,
    );
  if (body.dailyLimit != null && body.dailyLimit > s.maxEmployeeDailyLimit)
    throw badRequest(
      `Daily limit can't exceed the system maximum (${s.maxEmployeeDailyLimit})`,
    );
}

router.post(
  "/employees",
  validate({
    body: z.object({
      email: z.string().trim().toLowerCase().email().max(200),
      name: z.string().trim().min(1).max(120),
      password: z.string().min(10, "Use at least 10 characters").max(200),
      accountLimit: limitField,
      dailyLimit: limitField,
      hourlyLimit: limitField,
      requireApproval: z.boolean().optional(),
    }),
  }),
  ah(async (req, res) => {
    await checkLimits(req.body);
    const exists = await prisma.user.findUnique({
      where: { email: req.body.email },
    });
    if (exists) throw conflict("A user with this email already exists");
    const user = await prisma.user.create({
      data: {
        email: req.body.email,
        name: req.body.name,
        role: "EMPLOYEE",
        passwordHash: await hashPassword(req.body.password),
        accountLimit: req.body.accountLimit ?? null,
        dailyLimit: req.body.dailyLimit ?? null,
        hourlyLimit: req.body.hourlyLimit ?? null,
        requireApproval: req.body.requireApproval ?? false,
      },
      select: { id: true, email: true, name: true },
    });
    caches.dashboard.delPrefix("admin:");
    audit(req, "employee.created", "User", user.id, { email: user.email });
    res.status(201).json({ employee: user });
  }),
);

router.get(
  "/employees/:id",
  validate({ params: idParam }),
  ah(async (req, res) => {
    const u = await prisma.user.findFirst({
      where: { id: req.params.id, role: "EMPLOYEE" },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        sendingDisabled: true,
        accountLimit: true,
        dailyLimit: true,
        hourlyLimit: true,
        requireApproval: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });
    if (!u) throw notFound("Employee");
    const settings = await getSettings();
    const accounts = await prisma.emailAccount.findMany({
      where: { ownerId: u.id, deletedAt: null },
      select: ACCOUNT_PUBLIC,
      orderBy: { createdAt: "asc" },
    });
    const campaigns = await prisma.campaign.findMany({
      where: { ownerId: u.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        name: true,
        status: true,
        type: true,
        archived: true,
        createdAt: true,
        pausedByAdmin: true,
      },
    });
    const stats = await statsFor(campaigns.map((c) => c.id));
    const activity = await prisma.auditLog.findMany({
      where: { actorId: u.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json({
      employee: { ...u, effective: employeeLimits(u, settings) },
      accounts: await decorateAccounts(accounts, u, settings),
      campaigns: campaigns.map((c) => ({ ...c, stats: stats.get(c.id) })),
      activity,
    });
  }),
);

router.patch(
  "/employees/:id",
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      isActive: z.boolean().optional(),
      sendingDisabled: z.boolean().optional(),
      requireApproval: z.boolean().optional(),
      accountLimit: limitField,
      dailyLimit: limitField,
      hourlyLimit: limitField,
    }),
  }),
  ah(async (req, res) => {
    await checkLimits(req.body);
    const u = await prisma.user.findFirst({
      where: { id: req.params.id, role: "EMPLOYEE" },
    });
    if (!u) throw notFound("Employee");
    const data = { ...req.body };
    if (req.body.isActive === false) data.tokenVersion = { increment: 1 }; // force logout
    const updated = await prisma.user.update({
      where: { id: u.id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        sendingDisabled: true,
        accountLimit: true,
        dailyLimit: true,
        hourlyLimit: true,
        requireApproval: true,
      },
    });
    if (req.body.isActive === false)
      await prisma.refreshToken.updateMany({
        where: { userId: u.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    invalidateUser(u.id);
    invalidateOwner(u.id);
    audit(req, "employee.updated", "User", u.id, req.body);
    if (req.body.sendingDisabled !== undefined) {
      await notify({
        userId: u.id,
        type: "policy",
        title: req.body.sendingDisabled
          ? "Sending disabled by administrator"
          : "Sending re-enabled by administrator",
      });
    }
    res.json({ employee: updated });
  }),
);

router.post(
  "/employees/:id/reset-password",
  validate({
    params: idParam,
    body: z.object({ password: z.string().min(10).max(200) }),
  }),
  ah(async (req, res) => {
    const u = await prisma.user.findFirst({
      where: { id: req.params.id, role: "EMPLOYEE" },
    });
    if (!u) throw notFound("Employee");
    await prisma.$transaction([
      prisma.user.update({
        where: { id: u.id },
        data: {
          passwordHash: await hashPassword(req.body.password),
          tokenVersion: { increment: 1 },
        },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: u.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    invalidateUser(u.id);
    audit(req, "employee.password_reset", "User", u.id);
    res.json({ ok: true });
  }),
);

// ---------- settings / policies ----------
const settingsSchema = z
  .object({
    defaultAccountLimit: z.coerce.number().int().min(0).max(10_000),
    maxAccountLimit: z.coerce.number().int().min(1).max(10_000),
    defaultDailyLimit: z.coerce.number().int().min(0).max(100_000),
    defaultHourlyLimit: z.coerce.number().int().min(0).max(10_000),
    maxEmployeeDailyLimit: z.coerce.number().int().min(1).max(100_000),
    maxWorkingCampaigns: z.coerce.number().int().min(1).max(100),
    maxRetries: z.coerce.number().int().min(0).max(5),
    allowAccountCreate: z.boolean(),
    allowAccountEdit: z.boolean(),
    allowAccountDelete: z.boolean(),
    allowAccountReconnect: z.boolean(),
    trackingEnabled: z.boolean(),
    footerText: z.string().max(2000),
    footerHtml: z.string().max(5000),
    warmupStartPercent: z.coerce.number().int().min(1).max(100),
    warmupDays: z.coerce.number().int().min(1).max(90),
    bounceRatePauseThreshold: z.coerce.number().min(0.005).max(1),
    complaintRatePauseThreshold: z.coerce.number().min(0.0001).max(1),
    imapSyncIntervalMin: z.coerce.number().int().min(2).max(1440),
    healthCheckIntervalSec: z.coerce.number().int().min(60).max(3600),
    otpLoginEnabled: z.boolean(),
    otpForAdmins: z.boolean(),
    aiEnabled: z.boolean(),
    aiReplyAssist: z.boolean(),
    aiPerMinute: z.coerce.number().int().min(1).max(1000),
    aiDailyLimit: z.coerce.number().int().min(1).max(100_000),
    aiUserDailyLimit: z.coerce.number().int().min(1).max(10_000),
  })
  .partial();

const publicSettings = (s) => {
  const { systemMailRefreshEnc, ...rest } = s;
  return { ...rest, systemMailConnected: Boolean(systemMailRefreshEnc) };
};

router.get(
  "/settings",
  ah(async (req, res) =>
    res.json({
      settings: publicSettings(await getSettings()),
      systemMail: await systemMailStatus(),
      ai: await aiStatus(req.user.id),
    }),
  ),
);

// ---------- system mailbox (login OTP / password reset) ----------
router.get(
  "/system-mail",
  ah(async (_req, res) => res.json(await systemMailStatus())),
);

router.post(
  "/system-mail/test",
  rateLimit({
    name: "sysmail-test",
    max: 10,
    windowSec: 600,
    key: (req) => req.user.id,
  }),
  validate({ body: z.object({ to: z.string().trim().toLowerCase().email() }) }),
  ah(async (req, res) => {
    try {
      const via = await sendSystemMail({
        to: req.body.to,
        ...codeEmail({
          purpose: "LOGIN",
          code: "123456",
          name: req.user.name,
          minutes: 10,
        }),
        subject: "Emails Pro — OTP mailbox test",
      });
      audit(req, "settings.system_mail_test", "SystemSettings", "1", {
        to: req.body.to,
        via,
      });
      res.json({ ok: true, via });
    } catch (err) {
      const blocked = ["ETIMEDOUT", "ECONNECTION", "ESOCKET"].includes(
        err.code,
      );
      throw badRequest(
        err.code === "MAIL_NOT_CONFIGURED"
          ? "The OTP mailbox is not configured yet."
          : err.code === "EAUTH"
            ? "Gmail rejected the app password. Check SYSTEM_MAIL_APP_PASSWORD (2-Step Verification must be on)."
            : err.code === "BREVO_KEY"
              ? "Brevo rejected the API key. Check BREVO_API_KEY (Brevo → SMTP & API → API keys)."
              : err.code === "BREVO_SENDER"
                ? `Brevo does not accept the sender address. Add and verify it in Brevo → Senders, domains & dedicated IPs, and set SYSTEM_MAIL_FROM to it. (${String(err.message).slice(0, 120)})`
                : blocked
                  ? 'Could not reach the SMTP server. Render Free blocks SMTP ports 25/465/587 — set BREVO_API_KEY (free, HTTPS) or use "Connect with Google" instead.'
                  : `Sending failed: ${String(err.message).slice(0, 200)}`,
      );
    }
  }),
);

router.get(
  "/system-mail/google/start",
  ah(async (req, res) => {
    if (!googleOAuthEnabled())
      throw badRequest(
        "Google sign-in is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
      );
    const origin = (req.get("origin") || config.appUrl).replace(/\/$/, "");
    res.json({
      url: googleAuthUrl({
        userId: req.user.id,
        provider: "GMAIL",
        frontendOrigin: origin,
        kind: "system",
      }),
    });
  }),
);

router.delete(
  "/system-mail/google",
  ah(async (req, res) => {
    const s = await getSettings();
    const envReady = Boolean(config.systemMail.user && config.systemMail.pass);
    if ((s.otpLoginEnabled || s.otpForAdmins) && !envReady)
      throw badRequest(
        "Turn off email OTP first — otherwise nobody could sign in.",
      );
    await updateSettings({ systemMailEmail: null, systemMailRefreshEnc: null });
    audit(req, "settings.system_mail_disconnected", "SystemSettings", "1");
    res.json(await systemMailStatus());
  }),
);

router.put(
  "/settings",
  validate({ body: settingsSchema }),
  ah(async (req, res) => {
    const b = req.body;
    if (
      b.footerHtml !== undefined &&
      !b.footerHtml.includes("{{unsubscribeUrl}}")
    )
      throw badRequest(
        "The HTML footer must contain {{unsubscribeUrl}} — the unsubscribe mechanism cannot be removed",
      );
    if (
      b.footerText !== undefined &&
      !b.footerText.includes("{{unsubscribeUrl}}")
    )
      throw badRequest("The text footer must contain {{unsubscribeUrl}}");
    const current = await getSettings();
    if (
      (b.defaultAccountLimit ?? current.defaultAccountLimit) >
      (b.maxAccountLimit ?? current.maxAccountLimit)
    )
      throw badRequest("Default account limit cannot exceed the maximum");
    if (
      (b.defaultDailyLimit ?? current.defaultDailyLimit) >
      (b.maxEmployeeDailyLimit ?? current.maxEmployeeDailyLimit)
    )
      throw badRequest("Default daily limit cannot exceed the maximum");
    if (
      (b.otpLoginEnabled && !current.otpLoginEnabled) ||
      (b.otpForAdmins && !current.otpForAdmins)
    ) {
      const mail = await systemMailStatus();
      if (!mail.configured)
        throw badRequest(
          "Connect the OTP mailbox (or set SYSTEM_MAIL_APP_PASSWORD) and send a test email before enabling email OTP — otherwise nobody could sign in.",
        );
    }
    const settings = await updateSettings(b);
    caches.users.clear();
    caches.dashboard.clear();
    audit(req, "settings.updated", "SystemSettings", "1", b);
    res.json({ settings: publicSettings(settings) });
  }),
);

// ---------- emergency controls ----------
router.post(
  "/emergency",
  validate({
    body: z.object({
      scope: z.enum(["global", "employee", "account"]),
      id: z.string().max(40).optional(),
      stop: z.boolean(),
    }),
  }),
  ah(async (req, res) => {
    const { scope, id, stop } = req.body;
    if (scope === "global") {
      await updateSettings({ globalSendingPaused: stop });
      await notify({
        forAdmins: true,
        type: "emergency",
        title: stop ? "Global sending STOPPED" : "Global sending resumed",
        body: `By ${req.user.name}`,
      });
    } else if (scope === "employee") {
      if (!id) throw badRequest("Employee id required");
      await prisma.user.update({
        where: { id },
        data: { sendingDisabled: stop },
      });
      invalidateUser(id);
      await notify({
        userId: id,
        type: "emergency",
        title: stop
          ? "Sending stopped by administrator"
          : "Sending re-enabled by administrator",
      });
    } else {
      if (!id) throw badRequest("Account id required");
      const acc = await prisma.emailAccount.update({
        where: { id },
        data: stop
          ? { adminDisabled: true, status: "DISABLED" }
          : { adminDisabled: false, status: "CONNECTED" },
      });
      closeTransport(id);
      invalidateOwner(acc.ownerId);
      await notify({
        userId: acc.ownerId,
        type: "emergency",
        title: stop
          ? `${acc.email} disabled by administrator`
          : `${acc.email} re-enabled by administrator`,
      });
    }
    caches.dashboard.clear();
    audit(
      req,
      `emergency.${scope}.${stop ? "stop" : "resume"}`,
      scope,
      id || "global",
    );
    if (!stop) wakeWorker();
    res.json({ ok: true });
  }),
);

// ---------- SMTP account monitoring & policy ----------
router.get(
  "/accounts",
  validate({
    query: pagination.extend({
      employeeId: z.string().max(40).optional(),
      status: z.string().max(20).optional(),
      search: z.string().max(200).optional(),
    }),
  }),
  ah(async (req, res) => {
    const { page, pageSize, employeeId, status, search } = req.query;
    const settings = await getSettings();
    const where = {
      deletedAt: null,
      ...(employeeId ? { ownerId: employeeId } : {}),
      ...(status ? { status } : {}),
      ...(search ? { email: { contains: search.toLowerCase() } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.emailAccount.findMany({
        where,
        select: {
          ...ACCOUNT_PUBLIC,
          ownerId: true,
          warmupStartPercent: true,
          warmupDays: true,
          owner: {
            select: {
              id: true,
              name: true,
              email: true,
              dailyLimit: true,
              hourlyLimit: true,
              accountLimit: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.emailAccount.count({ where }),
    ]);
    const decorated = [];
    for (const a of items)
      decorated.push((await decorateAccounts([a], a.owner, settings))[0]);
    res.json({ items: decorated, total, page, pageSize });
  }),
);

router.patch(
  "/accounts/:id",
  validate({
    params: idParam,
    body: z.object({
      maxHourly: limitField,
      maxDaily: limitField,
      warmupEnabled: z.boolean().optional(),
      warmupStartPercent: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .nullable()
        .optional(),
      warmupDays: z.coerce.number().int().min(1).max(90).nullable().optional(),
      restartWarmup: z.boolean().optional(),
      status: z.enum(["CONNECTED", "PAUSED"]).optional(),
    }),
  }),
  ah(async (req, res) => {
    const acc = await prisma.emailAccount.findFirst({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!acc) throw notFound("Email account");
    const { restartWarmup, ...rest } = req.body;
    const data = { ...rest };
    if (restartWarmup || (rest.warmupEnabled && !acc.warmupStartedAt))
      data.warmupStartedAt = new Date();
    if (rest.status === "CONNECTED") {
      data.lastError = null;
      data.consecutiveFailures = 0;
    }
    const updated = await prisma.emailAccount.update({
      where: { id: acc.id },
      data,
      select: ACCOUNT_PUBLIC,
    });
    invalidateOwner(acc.ownerId);
    audit(req, "account.policy_updated", "EmailAccount", acc.id, req.body);
    if (rest.status === "CONNECTED") wakeWorker();
    res.json({ account: updated });
  }),
);

// ---------- campaign monitoring ----------
router.get(
  "/campaigns",
  validate({
    query: pagination.extend({
      status: z.string().max(20).optional(),
      employeeId: z.string().max(40).optional(),
    }),
  }),
  ah(async (req, res) => {
    const { page, pageSize, status, employeeId } = req.query;
    const where = {
      ...(status ? { status } : {}),
      ...(employeeId ? { ownerId: employeeId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          archived: true,
          hourlyRate: true,
          scheduledAt: true,
          startedAt: true,
          completedAt: true,
          pausedReason: true,
          pausedByAdmin: true,
          createdAt: true,
          subject: true,
          accountIds: true,
          owner: { select: { id: true, name: true, email: true } },
          account: { select: { email: true } },
        },
      }),
      prisma.campaign.count({ where }),
    ]);
    const stats = await statsFor(items.map((c) => c.id));
    res.json({
      items: items.map((c) => ({ ...c, stats: stats.get(c.id) })),
      total,
      page,
      pageSize,
    });
  }),
);

router.get(
  "/campaigns/:id",
  validate({ params: idParam }),
  ah(async (req, res) => {
    const c = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        subject: true,
        html: true,
        hourlyRate: true,
        scheduledAt: true,
        startedAt: true,
        completedAt: true,
        pausedReason: true,
        pausedByAdmin: true,
        createdAt: true,
        owner: { select: { id: true, name: true, email: true } },
        account: { select: { email: true } },
      },
    });
    if (!c) throw notFound("Campaign");
    res.json({ campaign: { ...c, stats: (await statsFor([c.id])).get(c.id) } });
  }),
);

router.post(
  "/campaigns/:id/pause",
  validate({
    params: idParam,
    body: z.object({ reason: z.string().trim().max(300).optional() }),
  }),
  ah(async (req, res) => {
    const c = await prisma.campaign.findUnique({
      where: { id: req.params.id },
    });
    if (!c) throw notFound("Campaign");
    const r = await prisma.campaign.updateMany({
      where: {
        id: c.id,
        status: { in: ["SENDING", "SCHEDULED", "PENDING_APPROVAL", "PAUSED"] },
      },
      data: {
        status: "PAUSED",
        pausedByAdmin: true,
        pausedReason: `Paused by administrator${req.body.reason ? `: ${req.body.reason}` : ""}`,
      },
    });
    if (!r.count)
      throw conflict("This campaign cannot be paused in its current state");
    invalidateOwner(c.ownerId);
    await notify({
      userId: c.ownerId,
      type: "campaign.admin_paused",
      title: `Campaign "${c.name}" paused by administrator`,
      body: req.body.reason,
    });
    audit(req, "campaign.admin_paused", "Campaign", c.id, {
      reason: req.body.reason,
    });
    res.json({ status: "PAUSED" });
  }),
);

// Releasing an admin pause does NOT send anything: the campaign stays PAUSED until the employee resumes it.
router.post(
  "/campaigns/:id/release",
  validate({ params: idParam }),
  ah(async (req, res) => {
    const c = await prisma.campaign.findUnique({
      where: { id: req.params.id },
    });
    if (!c) throw notFound("Campaign");
    await prisma.campaign.update({
      where: { id: c.id },
      data: {
        pausedByAdmin: false,
        pausedReason: "Admin hold released — employee may resume",
      },
    });
    invalidateOwner(c.ownerId);
    await notify({
      userId: c.ownerId,
      type: "campaign.admin_released",
      title: `You can resume "${c.name}" again`,
    });
    audit(req, "campaign.admin_released", "Campaign", c.id);
    res.json({ ok: true });
  }),
);

router.post(
  "/campaigns/:id/approve",
  validate({ params: idParam }),
  ah(async (req, res) => {
    const c = await prisma.campaign.findUnique({
      where: { id: req.params.id },
    });
    if (!c || c.status !== "PENDING_APPROVAL")
      throw conflict("Campaign is not awaiting approval");
    // Approval returns control to the employee: it becomes a DRAFT marked approved; the employee starts it.
    await prisma.campaign.update({
      where: { id: c.id },
      data: {
        status: "DRAFT",
        approvedAt: new Date(),
        approvedById: req.user.id,
      },
    });
    invalidateOwner(c.ownerId);
    await notify({
      userId: c.ownerId,
      type: "campaign.approved",
      title: `Campaign "${c.name}" approved`,
      body: "You can now start it.",
    });
    audit(req, "campaign.approved", "Campaign", c.id);
    res.json({ ok: true });
  }),
);

router.post(
  "/campaigns/:id/reject",
  validate({
    params: idParam,
    body: z.object({ reason: z.string().trim().max(300).optional() }),
  }),
  ah(async (req, res) => {
    const c = await prisma.campaign.findUnique({
      where: { id: req.params.id },
    });
    if (!c || c.status !== "PENDING_APPROVAL")
      throw conflict("Campaign is not awaiting approval");
    await prisma.campaign.update({
      where: { id: c.id },
      data: {
        status: "DRAFT",
        approvedAt: null,
        pausedReason: `Approval declined${req.body.reason ? `: ${req.body.reason}` : ""}`,
      },
    });
    invalidateOwner(c.ownerId);
    await notify({
      userId: c.ownerId,
      type: "campaign.rejected",
      title: `Campaign "${c.name}" was not approved`,
      body: req.body.reason,
    });
    audit(req, "campaign.rejected", "Campaign", c.id, {
      reason: req.body.reason,
    });
    res.json({ ok: true });
  }),
);

// ---------- deliverability & reports ----------
router.get(
  "/deliverability",
  ah(async (_req, res) => {
    const data = await caches.dashboard.wrap(
      "admin:deliverability",
      async () => {
        const since = new Date(Date.now() - 30 * 86_400_000);
        const rows = await prisma.$queryRaw`
      SELECT a.id, a.email, a.provider::text AS provider, a.status::text AS status, a."dnsSpf", a."dnsDmarc", u.name AS owner,
             count(r.id) FILTER (WHERE r."sentAt" IS NOT NULL)::int AS sent,
             count(r.id) FILTER (WHERE r.status = 'BOUNCED')::int AS bounced,
             count(r."unsubscribedAt")::int AS unsubscribed,
             count(r."repliedAt")::int AS replied,
             (SELECT count(*)::int FROM "SendAttempt" sa WHERE sa."accountId" = a.id AND sa."errorClass" = 'AUTH' AND sa."startedAt" >= ${since}) AS "authFailures",
             (SELECT count(*)::int FROM "SendAttempt" sa WHERE sa."accountId" = a.id AND sa."errorClass" = 'THROTTLED' AND sa."startedAt" >= ${since}) AS throttled
      FROM "EmailAccount" a
      JOIN "User" u ON u.id = a."ownerId"
      LEFT JOIN "CampaignRecipient" r ON r."accountId" = a.id AND r."createdAt" >= ${since}
      WHERE a."deletedAt" IS NULL
      GROUP BY a.id, u.name
      ORDER BY sent DESC
      LIMIT 200`;
        return rows.map((r) => ({
          ...r,
          bounceRate: r.sent ? r.bounced / r.sent : 0,
        }));
      },
      60_000,
    );
    res.json({
      accounts: data,
      note: "Complaint rates require provider feedback loops (e.g. Amazon SES notifications) and are not available for plain SMTP accounts.",
    });
  }),
);

router.get(
  "/reports",
  validate({
    query: z.object({
      days: z.coerce.number().int().min(1).max(90).default(30),
    }),
  }),
  ah(async (req, res) => {
    const since = new Date(Date.now() - req.query.days * 86_400_000);
    const data = await caches.dashboard.wrap(
      `admin:reports:${req.query.days}`,
      async () => {
        const perEmployee = await prisma.$queryRaw`
      SELECT u.id, u.name, u.email,
             count(r.id) FILTER (WHERE r."sentAt" >= ${since})::int AS sent,
             count(r."openedAt") FILTER (WHERE r."sentAt" >= ${since})::int AS opened,
             count(r."clickedAt") FILTER (WHERE r."sentAt" >= ${since})::int AS clicked,
             count(r."repliedAt") FILTER (WHERE r."sentAt" >= ${since})::int AS replied,
             count(r.id) FILTER (WHERE r.status = 'BOUNCED' AND r."createdAt" >= ${since})::int AS bounced,
             count(r.id) FILTER (WHERE r.status = 'FAILED' AND r."createdAt" >= ${since})::int AS failed
      FROM "User" u
      LEFT JOIN "Campaign" c ON c."ownerId" = u.id
      LEFT JOIN "CampaignRecipient" r ON r."campaignId" = c.id
      WHERE u.role = 'EMPLOYEE'
      GROUP BY u.id ORDER BY sent DESC LIMIT 500`;
        const daily = await prisma.$queryRaw`
      SELECT to_char(date_trunc('day', "sentAt"), 'YYYY-MM-DD') AS day, count(*)::int AS sent,
             count("repliedAt")::int AS replied, count(*) FILTER (WHERE status = 'BOUNCED')::int AS bounced
      FROM "CampaignRecipient" WHERE "sentAt" >= ${since} GROUP BY 1 ORDER BY 1`;
        return { perEmployee, daily };
      },
      60_000,
    );
    res.json(data);
  }),
);

// ---------- audit ----------
router.get(
  "/audit",
  validate({
    query: pagination.extend({
      action: z.string().max(100).optional(),
      actorId: z.string().max(40).optional(),
    }),
  }),
  ah(async (req, res) => {
    const { page, pageSize, action, actorId } = req.query;
    const where = {
      ...(action ? { action: { startsWith: action } } : {}),
      ...(actorId ? { actorId } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);
    const actors = new Map(
      (
        await prisma.user.findMany({
          where: {
            id: {
              in: [...new Set(items.map((i) => i.actorId).filter(Boolean))],
            },
          },
          select: { id: true, name: true, email: true },
        })
      ).map((u) => [u.id, u]),
    );
    res.json({
      items: items.map((i) => ({ ...i, actor: actors.get(i.actorId) || null })),
      total,
      page,
      pageSize,
    });
  }),
);

// ---------- monitoring ----------
router.get(
  "/monitoring",
  ah(async (_req, res) => {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const stuckCutoff = new Date(Date.now() - 2 * 3_600_000);
    const [
      dbMs,
      checks,
      lease,
      unknown,
      onHold,
      stalled,
      imapErrors,
      authErrors,
    ] = await Promise.all([
      pingDb().catch(() => null),
      prisma.healthCheck.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 300,
      }),
      prisma.workerLease.findUnique({ where: { id: "primary" } }),
      prisma.campaignRecipient.count({ where: { status: "UNKNOWN" } }),
      prisma.campaignRecipient.count({ where: { status: "ON_HOLD" } }),
      prisma.$queryRaw`
      SELECT c.id, c.name, u.name AS owner, max(r."sentAt") AS "lastSentAt",
             count(*) FILTER (WHERE r.status = 'PENDING')::int AS pending
      FROM "Campaign" c JOIN "User" u ON u.id = c."ownerId"
      JOIN "CampaignRecipient" r ON r."campaignId" = c.id
      WHERE c.status = 'SENDING'
      GROUP BY c.id, u.name
      HAVING count(*) FILTER (WHERE r.status = 'PENDING') > 0 AND (max(r."sentAt") IS NULL OR max(r."sentAt") < ${stuckCutoff})
      LIMIT 50`,
      prisma.emailAccount.count({
        where: { deletedAt: null, imapHost: { not: null }, imapOk: false },
      }),
      prisma.emailAccount.count({
        where: { deletedAt: null, status: "ERROR" },
      }),
    ]);
    let redis = null;
    if (redisConfigured()) {
      try {
        redis = { ok: true, latencyMs: await pingRedis() };
      } catch (err) {
        redis = { ok: false, error: err.message };
      }
    }
    const latest = {};
    for (const c of checks) if (!latest[c.component]) latest[c.component] = c;
    const failures = checks.filter((c) => !c.ok).slice(0, 20);
    const lastSuccess =
      checks.find((c) => c.ok && c.component === "DATABASE")?.createdAt || null;
    const egress = await smtpEgress();
    res.json({
      smtpEgress: egress,
      api: {
        ok: true,
        ...processStats(),
        smtpTransportsOpen: transportCount(),
        caches: cacheStats(),
      },
      database: {
        ok: dbMs !== null,
        latencyMs: dbMs,
        lastSuccessfulCheck: lastSuccess,
      },
      redis: redisConfigured() ? redis : { configured: false },
      worker: {
        ...workerState(),
        lease,
        heartbeatAgeSec: lease
          ? Math.round(
              (Date.now() - new Date(lease.heartbeatAt).getTime()) / 1000,
            )
          : null,
      },
      queue: {
        unknownSends: unknown,
        onHold,
        stalledCampaigns: stalled,
        imapErrors,
        accountsInError: authErrors,
      },
      latest,
      recentFailures: failures,
      timeline: checks
        .filter((c) => c.component === "WORKER" || !c.ok)
        .slice(0, 30),
      note: "Render Free services sleep after inactivity. These checks run inside the service, so they cannot observe the sleep itself — gaps are reported when the worker resumes.",
    });
  }),
);

export default router;
