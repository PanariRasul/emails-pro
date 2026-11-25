import { Router } from "express";
import { z } from "zod";
import { config } from "../config/index.js";
import { prisma } from "../lib/prisma.js";
import { encryptSecret } from "../lib/crypto.js";
import { invalidateOwner } from "../lib/cache.js";
import {
  ah,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from "../lib/errors.js";
import { rateLimit } from "../lib/rateLimit.js";
import { idParam, validate } from "../middleware/common.js";
import { employeeOnly, requireAuth } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { getSettings, updateSettings } from "../services/settings.js";
import {
  accountLimits,
  dayWindow,
  employeeLimits,
  hourWindow,
  speedOptions,
} from "../services/limits.js";
import {
  PROVIDER_PRESETS,
  checkDns,
  closeTransport,
} from "../services/smtp.js";
import { deliver, testSending, transportKind } from "../services/transports.js";
import { smtpEgress } from "../services/egress.js";
import { testImap } from "../services/imap.js";
import {
  exchangeCode,
  forgetAccessToken,
  googleAuthUrl,
  googleOAuthEnabled,
  verifyState,
} from "../services/oauth.js";
import { makeMessageId } from "../services/template.js";

const router = Router();

// Fields safe to return. Encrypted secrets are NEVER selected for API responses.
export const ACCOUNT_PUBLIC = {
  id: true,
  email: true,
  displayName: true,
  groupName: true,
  provider: true,
  authType: true,
  smtpHost: true,
  smtpPort: true,
  smtpSecure: true,
  smtpUser: true,
  imapHost: true,
  imapPort: true,
  imapSecure: true,
  imapUser: true,
  status: true,
  smtpOk: true,
  imapOk: true,
  adminDisabled: true,
  lastTestAt: true,
  lastError: true,
  maxHourly: true,
  maxDaily: true,
  warmupEnabled: true,
  warmupStartedAt: true,
  dnsSpf: true,
  dnsDmarc: true,
  imapLastSyncAt: true,
  imapSpamPath: true,
  consecutiveFailures: true,
  createdAt: true,
};

export async function usageFor(accountIds, now = new Date()) {
  if (!accountIds.length) return new Map();
  const scopesH = accountIds.map((id) => `acct:${id}:hour`);
  const scopesD = accountIds.map((id) => `acct:${id}:day`);
  const rows = await prisma.usageCounter.findMany({
    where: {
      OR: [
        { scope: { in: scopesH }, windowStart: hourWindow(now) },
        { scope: { in: scopesD }, windowStart: dayWindow(now) },
      ],
    },
  });
  const m = new Map(accountIds.map((id) => [id, { hour: 0, day: 0 }]));
  for (const r of rows) {
    const [, id, w] = r.scope.split(":");
    m.get(id)[w] = r.count;
  }
  return m;
}

async function bounceRates(accountIds) {
  if (!accountIds.length) return new Map();
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await prisma.campaignRecipient.groupBy({
    by: ["accountId", "status"],
    where: {
      accountId: { in: accountIds },
      sentAt: { gte: since },
      status: { in: ["SENT", "BOUNCED"] },
    },
    _count: { _all: true },
  });
  const m = new Map();
  for (const r of rows) {
    const e = m.get(r.accountId) || { sent: 0, bounced: 0 };
    if (r.status === "BOUNCED") e.bounced += r._count._all;
    e.sent += r._count._all;
    m.set(r.accountId, e);
  }
  return m;
}

export async function decorateAccounts(accounts, owner, settings) {
  const ids = accounts.map((a) => a.id);
  const [usage, bounces] = await Promise.all([usageFor(ids), bounceRates(ids)]);
  return accounts.map((a) => {
    const lim = accountLimits(a, owner, settings);
    const b = bounces.get(a.id);
    return {
      ...a,
      transport: transportKind(a),
      limits: lim,
      usage: usage.get(a.id),
      bounceRate: b && b.sent ? b.bounced / b.sent : 0,
      speedOptions: speedOptions(lim.hourly),
    };
  });
}

router.get(
  "/providers",
  requireAuth,
  ah(async (_req, res) => {
    const egress = await smtpEgress();
    res.json({
      providers: PROVIDER_PRESETS,
      googleOAuth: googleOAuthEnabled(),
      smtpEgress: egress,
    });
  }),
);

router.get(
  "/",
  employeeOnly,
  ah(async (req, res) => {
    const settings = await getSettings();
    const accounts = await prisma.emailAccount.findMany({
      where: { ownerId: req.user.id, deletedAt: null },
      select: { ...ACCOUNT_PUBLIC, warmupStartPercent: true, warmupDays: true },
      orderBy: { createdAt: "asc" },
    });
    const limits = employeeLimits(req.user, settings);
    // The employee's daily limit is ONE total for all of their mailboxes together (set by the admin).
    const empDay = await prisma.usageCounter.findUnique({
      where: {
        scope_windowStart: {
          scope: `emp:${req.user.id}:day`,
          windowStart: dayWindow(),
        },
      },
    });
    res.json({
      accounts: await decorateAccounts(accounts, req.user, settings),
      slots: {
        limit: limits.accounts,
        used: accounts.length,
        remaining: Math.max(0, limits.accounts - accounts.length),
      },
      dailyTotal: {
        limit: limits.daily,
        sent: empDay?.count ?? 0,
        remaining: Math.max(0, limits.daily - (empDay?.count ?? 0)),
      },
      permissions: {
        create: settings.allowAccountCreate,
        edit: settings.allowAccountEdit,
        delete: settings.allowAccountDelete,
        reconnect: settings.allowAccountReconnect,
      },
    });
  }),
);

const providerEnum = z.enum([
  "GMAIL",
  "GOOGLE_WORKSPACE",
  "ZOHO",
  "YAHOO",
  "REDIFFMAIL",
  "AMAZON_SES",
  "CUSTOM",
]);
const host = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/, "Invalid hostname");

const AWS_REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

// Amazon SES via HTTPS API: region + IAM access key id (smtpUser) + secret access key (smtpPass).
// Fill the SMTP-shaped fields so one schema/table serves every transport.
const withSesDefaults = (body) => {
  if (body && body.sendMethod === "SES_API") {
    const region = AWS_REGION.test(body.sesRegion || "")
      ? body.sesRegion
      : "invalid";
    return {
      ...body,
      provider: "AMAZON_SES",
      smtpHost: `email.${region}.amazonaws.com`,
      smtpPort: 443,
      smtpSecure: true,
    };
  }
  return body;
};

const accountSchema = z.object({
  sendMethod: z.enum(["SMTP", "SES_API"]).default("SMTP"),
  sesRegion: z.string().trim().max(30).optional().nullable(),
  email: z.string().trim().toLowerCase().email().max(200),
  displayName: z.string().trim().max(120).optional().nullable(),
  groupName: z.string().trim().max(60).optional().nullable(),
  provider: providerEnum,
  smtpHost: host,
  smtpPort: z.coerce.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  smtpUser: z.string().trim().min(1).max(200),
  smtpPass: z.string().min(1).max(500),
  imapHost: host.optional().nullable().or(z.literal("")),
  imapPort: z.coerce.number().int().min(1).max(65535).optional().nullable(),
  imapSecure: z.boolean().optional(),
  imapUser: z.string().trim().max(200).optional().nullable(),
  imapPass: z.string().max(500).optional().nullable(),
  dkimSelector: z.string().trim().max(63).optional().nullable(),
});
const createAccountSchema = z.preprocess(
  withSesDefaults,
  accountSchema.refine(
    (b) => b.sendMethod !== "SES_API" || !b.smtpHost.includes("invalid"),
    {
      message: "Choose a valid AWS region (e.g. us-east-1, ap-south-1)",
      path: ["sesRegion"],
    },
  ),
);

async function runConnectionTests(acc, dkimSelector) {
  const [smtp, imap, dns] = await Promise.all([
    testSending(acc),
    acc.imapHost
      ? testImap(acc)
      : Promise.resolve({ ok: false, skipped: true }),
    checkDns(acc.email, dkimSelector).catch(() => ({ spf: null, dmarc: null })),
  ]);
  return { smtp, imap, dns };
}

/** Lock the employee's account set (transaction-scoped advisory lock — safe with Neon's pooler). */
async function lockOwner(tx, ownerId) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`accounts:${ownerId}`}))`;
}

router.post(
  "/",
  employeeOnly,
  rateLimit({
    name: "acct-create",
    max: 30,
    windowSec: 3600,
    key: (req) => req.user.id,
  }),
  validate({ body: createAccountSchema }),
  ah(async (req, res) => {
    const settings = await getSettings();
    const b = req.body;
    const authType = b.sendMethod === "SES_API" ? "SES_API" : "PASSWORD";
    const draft = {
      id: "test",
      email: b.email,
      provider: b.provider,
      authType,
      updatedAt: new Date(),
      smtpHost: b.smtpHost,
      smtpPort: b.smtpPort,
      smtpSecure: b.smtpSecure,
      smtpUser: b.smtpUser,
      smtpPassEnc: encryptSecret(b.smtpPass),
      imapHost: b.imapHost || null,
      imapPort: b.imapPort || null,
      imapSecure: b.imapSecure ?? true,
      imapUser: b.imapUser || null,
      imapPassEnc: b.imapPass ? encryptSecret(b.imapPass) : null,
    };

    const existing = await prisma.emailAccount.findUnique({
      where: { ownerId_email: { ownerId: req.user.id, email: b.email } },
    });
    if (existing && !existing.deletedAt)
      throw conflict(
        'This email account is already connected. Use "Reconnect" to update its credentials.',
        "ACCOUNT_EXISTS",
      );
    if (existing && !settings.allowAccountReconnect)
      throw forbidden(
        "Reconnecting accounts is currently disabled by your administrator",
      );
    if (!existing && !settings.allowAccountCreate)
      throw forbidden(
        "Adding accounts is currently disabled by your administrator",
      );

    // Ownership is global per mailbox: another employee can't connect the same address.
    const other = await prisma.emailAccount.findFirst({
      where: { email: b.email, ownerId: { not: req.user.id }, deletedAt: null },
      select: { id: true },
    });
    if (other)
      throw conflict(
        "This mailbox is already connected by another employee.",
        "ACCOUNT_OWNED_ELSEWHERE",
      );

    const tests = await runConnectionTests(draft, b.dkimSelector);
    if (!tests.smtp.ok)
      throw badRequest(`Sending test failed: ${tests.smtp.error}`, { tests });

    const limit = employeeLimits(req.user, settings).accounts;
    const data = {
      email: b.email,
      displayName: b.displayName || null,
      groupName: b.groupName || defaultGroup(b.provider),
      provider: b.provider,
      authType,
      smtpHost: b.smtpHost,
      smtpPort: b.smtpPort,
      smtpSecure: b.smtpSecure,
      smtpUser: b.smtpUser,
      smtpPassEnc: draft.smtpPassEnc,
      imapHost: draft.imapHost,
      imapPort: draft.imapPort,
      imapSecure: draft.imapSecure,
      imapUser: draft.imapUser,
      imapPassEnc: draft.imapPassEnc,
      status: "CONNECTED",
      smtpOk: true,
      imapOk: Boolean(tests.imap.ok),
      lastTestAt: new Date(),
      lastError:
        tests.imap.ok || tests.imap.skipped
          ? null
          : `IMAP: ${tests.imap.error}`,
      dnsSpf: tests.dns.spf,
      dnsDmarc: tests.dns.dmarc,
      consecutiveFailures: 0,
      deletedAt: null,
      imapNextSyncAt: new Date(),
      imapLastUid: null,
      imapUidValidity: null,
      imapSpamPath: null,
      imapSpamLastUid: null,
      imapSpamUidValidity: null,
    };

    const account = await prisma.$transaction(async (tx) => {
      await lockOwner(tx, req.user.id);
      const count = await tx.emailAccount.count({
        where: { ownerId: req.user.id, deletedAt: null },
      });
      if (count >= limit)
        throw conflict(
          `You have reached your limit of ${limit} email accounts.`,
          "ACCOUNT_LIMIT",
        );
      if (existing)
        return tx.emailAccount.update({
          where: { id: existing.id },
          data,
          select: ACCOUNT_PUBLIC,
        });
      return tx.emailAccount.create({
        data: {
          ...data,
          ownerId: req.user.id,
          warmupEnabled: true,
          warmupStartedAt: new Date(),
        },
        select: ACCOUNT_PUBLIC,
      });
    });
    invalidateOwner(req.user.id);
    audit(
      req,
      existing ? "account.reconnected" : "account.created",
      "EmailAccount",
      account.id,
      { email: b.email, provider: b.provider },
    );
    res.status(existing ? 200 : 201).json({ account, tests });
  }),
);

async function ownedAccount(req, id, extra = {}) {
  const a = await prisma.emailAccount.findFirst({
    where: { id, ownerId: req.user.id, deletedAt: null },
    ...extra,
  });
  if (!a) throw notFound("Email account");
  return a;
}

const updateSchema = accountSchema
  .partial()
  .omit({ email: true })
  .extend({ smtpPass: z.string().max(500).optional() });

const GROUP_DEFAULTS = {
  GMAIL: "Gmail",
  GOOGLE_WORKSPACE: "Google Workspace",
  ZOHO: "Zoho",
  YAHOO: "Yahoo",
  REDIFFMAIL: "Rediffmail",
  AMAZON_SES: "Amazon SES",
  CUSTOM: "Custom SMTP",
};
export const defaultGroup = (provider) => GROUP_DEFAULTS[provider] || null;

// Put several mailboxes into a group at once (e.g. "Gmail team A"). Groups are just labels for quick selection.
router.post(
  "/group",
  employeeOnly,
  validate({
    body: z.object({
      ids: z.array(z.string().max(40)).min(1).max(500),
      groupName: z.string().trim().max(60).nullable(),
    }),
  }),
  ah(async (req, res) => {
    const r = await prisma.emailAccount.updateMany({
      where: {
        id: { in: req.body.ids },
        ownerId: req.user.id,
        deletedAt: null,
      },
      data: { groupName: req.body.groupName || null },
    });
    invalidateOwner(req.user.id);
    audit(req, "account.grouped", "EmailAccount", null, {
      count: r.count,
      groupName: req.body.groupName,
    });
    res.json({ updated: r.count });
  }),
);

router.patch(
  "/:id",
  employeeOnly,
  validate({ params: idParam, body: updateSchema }),
  ah(async (req, res) => {
    const settings = await getSettings();
    if (!settings.allowAccountEdit)
      throw forbidden(
        "Editing accounts is currently disabled by your administrator",
      );
    const acc = await ownedAccount(req, req.params.id);
    const b = req.body;
    if (acc.authType === "OAUTH2" && (b.smtpPass || b.smtpHost || b.smtpUser))
      throw badRequest(
        "This account uses Google sign-in — reconnect it with Google instead",
      );
    if (acc.authType === "SES_API") {
      b.smtpHost = undefined;
      b.smtpPort = undefined;
      b.smtpSecure = undefined;
      if (b.sesRegion && AWS_REGION.test(b.sesRegion))
        b.smtpHost = `email.${b.sesRegion}.amazonaws.com`;
    }
    const data = {};
    if (b.groupName !== undefined) data.groupName = b.groupName || null;
    for (const k of [
      "displayName",
      "provider",
      "smtpHost",
      "smtpPort",
      "smtpSecure",
      "smtpUser",
      "imapPort",
      "imapSecure",
      "imapUser",
    ]) {
      if (b[k] !== undefined) data[k] = b[k];
    }
    if (b.imapHost !== undefined) data.imapHost = b.imapHost || null;
    if (b.smtpPass) data.smtpPassEnc = encryptSecret(b.smtpPass);
    if (b.imapPass) data.imapPassEnc = encryptSecret(b.imapPass);

    const credsChanged = [
      "smtpHost",
      "smtpPort",
      "smtpSecure",
      "smtpUser",
      "smtpPassEnc",
      "imapHost",
      "imapPort",
      "imapUser",
      "imapPassEnc",
    ].some((k) => k in data);
    let tests = null;
    if (credsChanged) {
      tests = await runConnectionTests(
        { ...acc, ...data, updatedAt: new Date() },
        b.dkimSelector,
      );
      if (!tests.smtp.ok)
        throw badRequest(`Sending test failed: ${tests.smtp.error}`, { tests });
      Object.assign(data, {
        smtpOk: true,
        imapOk: Boolean(tests.imap.ok),
        lastTestAt: new Date(),
        consecutiveFailures: 0,
        status: acc.adminDisabled ? "DISABLED" : "CONNECTED",
        lastError: null,
      });
    }
    const account = await prisma.emailAccount.update({
      where: { id: acc.id },
      data,
      select: ACCOUNT_PUBLIC,
    });
    closeTransport(acc.id);
    invalidateOwner(req.user.id);
    audit(
      req,
      credsChanged ? "account.credentials_updated" : "account.updated",
      "EmailAccount",
      acc.id,
    );
    res.json({ account, tests });
  }),
);

router.post(
  "/:id/test",
  employeeOnly,
  rateLimit({
    name: "acct-test",
    max: 20,
    windowSec: 600,
    key: (req) => req.user.id,
  }),
  validate({ params: idParam }),
  ah(async (req, res) => {
    const acc = await ownedAccount(req, req.params.id);
    const tests = await runConnectionTests(acc);
    const status = acc.adminDisabled
      ? "DISABLED"
      : tests.smtp.ok
        ? acc.status === "PAUSED"
          ? "PAUSED"
          : "CONNECTED"
        : "ERROR";
    const account = await prisma.emailAccount.update({
      where: { id: acc.id },
      data: {
        smtpOk: tests.smtp.ok,
        imapOk: Boolean(tests.imap.ok),
        lastTestAt: new Date(),
        status,
        lastError: tests.smtp.ok
          ? tests.imap.ok || tests.imap.skipped
            ? null
            : `IMAP: ${tests.imap.error}`
          : tests.smtp.error,
        dnsSpf: tests.dns.spf,
        dnsDmarc: tests.dns.dmarc,
        ...(tests.smtp.ok ? { consecutiveFailures: 0 } : {}),
      },
      select: ACCOUNT_PUBLIC,
    });
    closeTransport(acc.id);
    invalidateOwner(req.user.id);
    res.json({ account, tests });
  }),
);

router.post(
  "/:id/test-email",
  employeeOnly,
  rateLimit({
    name: "acct-test-email",
    max: 10,
    windowSec: 3600,
    key: (req) => req.user.id,
  }),
  validate({
    params: idParam,
    body: z.object({ to: z.string().trim().toLowerCase().email() }),
  }),
  ah(async (req, res) => {
    const acc = await ownedAccount(req, req.params.id);
    if (acc.status === "DISABLED" || acc.adminDisabled)
      throw forbidden("This account is disabled");
    await deliver(acc, {
      from: acc.displayName
        ? { name: acc.displayName, address: acc.email }
        : acc.email,
      to: req.body.to,
      subject: "Emails Pro — test message",
      text: `This is a test message from Emails Pro sent through ${acc.email}.`,
      messageId: makeMessageId(acc.email),
    });
    audit(req, "account.test_email", "EmailAccount", acc.id, {
      to: req.body.to,
    });
    res.json({ ok: true });
  }),
);

router.delete(
  "/:id",
  employeeOnly,
  validate({ params: idParam }),
  ah(async (req, res) => {
    const settings = await getSettings();
    if (!settings.allowAccountDelete)
      throw forbidden(
        "Removing accounts is currently disabled by your administrator",
      );
    const acc = await ownedAccount(req, req.params.id);
    const active = await prisma.campaign.count({
      where: { accountId: acc.id, status: "SENDING" },
    });
    if (active)
      throw conflict(
        "Pause the campaigns that are sending from this account first.",
        "ACCOUNT_IN_USE",
      );
    // Soft delete: campaign + sending history stay intact.
    await prisma.emailAccount.update({
      where: { id: acc.id },
      data: {
        deletedAt: new Date(),
        status: "DISABLED",
        smtpPassEnc: null,
        imapPassEnc: null,
        oauthRefreshEnc: null,
      },
    });
    closeTransport(acc.id);
    forgetAccessToken(acc.id);
    invalidateOwner(req.user.id);
    audit(req, "account.deleted", "EmailAccount", acc.id, { email: acc.email });
    res.json({ ok: true });
  }),
);

// ---------- Google OAuth ----------
export const oauthRouter = Router();

oauthRouter.get(
  "/google/start",
  employeeOnly,
  validate({
    query: z.object({
      provider: z.enum(["GMAIL", "GOOGLE_WORKSPACE"]).default("GMAIL"),
      displayName: z.string().max(120).optional(),
    }),
  }),
  ah(async (req, res) => {
    if (!googleOAuthEnabled())
      throw badRequest("Google sign-in is not configured on this server");
    const origin = (req.get("origin") || config.corsOrigins[0] || "").replace(
      /\/$/,
      "",
    );
    res.json({
      url: googleAuthUrl({
        userId: req.user.id,
        provider: req.query.provider,
        displayName: req.query.displayName,
        frontendOrigin: origin,
      }),
    });
  }),
);

oauthRouter.get(
  "/google/callback",
  ah(async (req, res) => {
    let state;
    try {
      state = verifyState(String(req.query.state || ""));
    } catch {
      return res.status(400).send("Invalid or expired sign-in request.");
    }
    const fo = config.corsOrigins.includes(state.fo)
      ? state.fo
      : config.corsOrigins[0];
    const back = (status, msg) =>
      res.redirect(
        `${fo}/app/accounts?oauth=${status}${msg ? `&message=${encodeURIComponent(msg)}` : ""}`,
      );
    if (req.query.error) return back("error", String(req.query.error));
    if (state.kind === "system") {
      const toSettings = (status, msg) =>
        res.redirect(
          `${fo}/admin/settings?tab=security&mailer=${status}${msg ? `&message=${encodeURIComponent(msg)}` : ""}`,
        );
      if (req.query.error) return toSettings("error", String(req.query.error));
      try {
        const admin = await prisma.user.findUnique({
          where: { id: state.uid },
        });
        if (!admin?.isActive || admin.role !== "ADMIN")
          return toSettings("error", "Not allowed");
        const g = await exchangeCode(String(req.query.code || ""));
        if (!g.refreshToken)
          return toSettings(
            "error",
            "Google did not return a refresh token. Remove Emails Pro from the Google account permissions and try again.",
          );
        await updateSettings({
          systemMailEmail: g.email,
          systemMailRefreshEnc: encryptSecret(g.refreshToken),
        });
        forgetAccessToken("system-mailer");
        audit(
          { user: admin, ip: req.ip },
          "settings.system_mail_connected",
          "SystemSettings",
          "1",
          { email: g.email },
        );
        return toSettings("connected");
      } catch {
        return toSettings("error", "Google sign-in failed");
      }
    }
    try {
      const owner = await prisma.user.findUnique({ where: { id: state.uid } });
      if (!owner?.isActive || owner.role !== "EMPLOYEE")
        return back("error", "Not allowed");
      const settings = await getSettings();
      const g = await exchangeCode(String(req.query.code || ""));
      if (!g.refreshToken)
        return back(
          "error",
          "Google did not return a refresh token. Remove Emails Pro from your Google account permissions and try again.",
        );
      const other = await prisma.emailAccount.findFirst({
        where: { email: g.email, ownerId: { not: owner.id }, deletedAt: null },
      });
      if (other)
        return back(
          "error",
          "This mailbox is already connected by another employee.",
        );
      const existing = await prisma.emailAccount.findUnique({
        where: { ownerId_email: { ownerId: owner.id, email: g.email } },
      });
      if (existing && existing.deletedAt && !settings.allowAccountReconnect)
        return back("error", "Reconnecting accounts is disabled");
      if (!existing && !settings.allowAccountCreate)
        return back("error", "Adding accounts is disabled");
      const data = {
        email: g.email,
        displayName: state.displayName || g.name || null,
        groupName: existing?.groupName || defaultGroup(state.provider),
        provider: state.provider,
        authType: "OAUTH2",
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        smtpSecure: true,
        smtpUser: g.email,
        smtpPassEnc: null,
        imapHost: "imap.gmail.com",
        imapPort: 993,
        imapSecure: true,
        imapUser: g.email,
        imapPassEnc: null,
        oauthRefreshEnc: encryptSecret(g.refreshToken),
        status: "CONNECTED",
        smtpOk: true,
        imapOk: true,
        lastTestAt: new Date(),
        lastError: null,
        deletedAt: null,
        consecutiveFailures: 0,
        imapNextSyncAt: new Date(),
        imapLastUid: null,
        imapUidValidity: null,
        imapSpamPath: null,
        imapSpamLastUid: null,
        imapSpamUidValidity: null,
      };
      const limit = employeeLimits(owner, settings).accounts;
      const acc = await prisma.$transaction(async (tx) => {
        await lockOwner(tx, owner.id);
        if (existing && !existing.deletedAt)
          return tx.emailAccount.update({ where: { id: existing.id }, data });
        const count = await tx.emailAccount.count({
          where: { ownerId: owner.id, deletedAt: null },
        });
        if (count >= limit)
          throw conflict("Account limit reached", "ACCOUNT_LIMIT");
        if (existing)
          return tx.emailAccount.update({ where: { id: existing.id }, data });
        return tx.emailAccount.create({
          data: {
            ...data,
            ownerId: owner.id,
            warmupEnabled: true,
            warmupStartedAt: new Date(),
          },
        });
      });
      forgetAccessToken(acc.id);
      closeTransport(acc.id);
      invalidateOwner(owner.id);
      audit(
        { user: owner, ip: req.ip },
        "account.oauth_connected",
        "EmailAccount",
        acc.id,
        { email: g.email },
      );
      return back("success");
    } catch (err) {
      return back(
        "error",
        err.code === "ACCOUNT_LIMIT"
          ? "You have reached your account limit"
          : "Google sign-in failed",
      );
    }
  }),
);

export default router;
