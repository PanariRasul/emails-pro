// End-to-end test: real API process + real PostgreSQL + fake SMTP server.
// Runs only when E2E_DATABASE_URL points at a DISPOSABLE database (never production).
//   E2E_DATABASE_URL=postgresql://user:pass@localhost:5432/emailspro_test npm test
// Uses unique emails per run; it never resets or deletes data.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { SMTPServer } from "smtp-server";
import { setTimeout as wait } from "node:timers/promises";
import http from "node:http";

const DB = process.env.E2E_DATABASE_URL;
const skip = !DB && "E2E_DATABASE_URL not set";
const PORT = 10500 + Math.floor(Math.random() * 400);
const SMTP_PORT = 2600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const ADMIN = {
  email: `admin-${RUN}@example.com`,
  password: "AdminPassword123!",
};

const received = [];
const sesCalls = [];
let smtp;
let api;
let ses;
let gem;
const gemini = { calls: 0, mode: "ok", last: null };
const GEM_PORT = 3200 + Math.floor(Math.random() * 300);
function startFakeGemini() {
  gem = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      gemini.calls += 1;
      res.setHeader("Content-Type", "application/json");
      if (req.headers["x-goog-api-key"] !== "e2e-gemini-key") {
        res.statusCode = 403;
        return res.end("{}");
      }
      const reqBody = JSON.parse(body || "{}");
      gemini.last = reqBody;
      gemini.lastPath = req.url;
      if (
        gemini.mode === "nothink" &&
        reqBody.generationConfig?.thinkingConfig
      ) {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            error: {
              code: 400,
              message: "Thinking level is not supported for this model.",
            },
          }),
        );
      }
      if (gemini.mode === "503once") {
        gemini.mode = "ok";
        res.statusCode = 503;
        return res.end(
          JSON.stringify({
            error: {
              code: 503,
              message: "The model is overloaded. Please try again later.",
            },
          }),
        );
      }
      if (gemini.mode === "503") {
        res.statusCode = 503;
        return res.end(
          JSON.stringify({
            error: {
              code: 503,
              message: "The model is overloaded. Please try again later.",
            },
          }),
        );
      }
      if (gemini.mode === "429") {
        res.statusCode = 429;
        return res.end(
          JSON.stringify({
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.RetryInfo",
                  retryDelay: "30s",
                },
              ],
            },
          }),
        );
      }
      const p = JSON.parse(body || "{}").contents?.[0]?.parts?.[0]?.text || "";
      const out = /Review this cold email/.test(p)
        ? {
            score: 70,
            summary: "ok",
            subjects: [{ subject: "Hi", score: 60, tip: "t" }],
            strengths: ["a"],
            improvements: ["b"],
            subjectIdeas: ["Quick question, {{firstName}}"],
          }
        : /Rewrite this cold email/.test(p)
          ? { html: "<p>Hi {{firstName}}</p><script>x</script>", note: "n" }
          : { text: "Hi Bob,\n\nMonday works.\n\nThanks" };
      return res.end(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }],
        }),
      );
    });
  });
  return new Promise((r) => gem.listen(GEM_PORT, "127.0.0.1", r));
}
const SES_PORT = 2900 + Math.floor(Math.random() * 300);

function startMockSes() {
  ses = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      sesCalls.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || "",
        body,
      });
      res.setHeader("Content-Type", "application/json");
      if (
        !/^AWS4-HMAC-SHA256 Credential=AKIATEST\//.test(
          req.headers.authorization || "",
        )
      ) {
        res.statusCode = 403;
        return res.end('{"message":"SignatureDoesNotMatch"}');
      }
      if (req.method === "GET" && req.url === "/v2/email/account")
        return res.end(
          JSON.stringify({
            SendingEnabled: true,
            ProductionAccessEnabled: false,
            SendQuota: { Max24HourSend: 200, MaxSendRate: 1 },
          }),
        );
      if (req.method === "POST" && req.url === "/v2/email/outbound-emails")
        return res.end(
          JSON.stringify({ MessageId: `0100abc-${sesCalls.length}-000000` }),
        );
      res.statusCode = 404;
      return res.end("{}");
    });
  });
  return new Promise((r) => ses.listen(SES_PORT, "127.0.0.1", r));
}

function startSmtp() {
  smtp = new SMTPServer({
    authOptional: false,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _s, cb) {
      if (
        (auth.username === "user" || auth.username.includes("@")) &&
        auth.password === "pass"
      )
        return cb(null, { user: auth.username });
      return cb(
        Object.assign(new Error("Invalid credentials"), { responseCode: 535 }),
      );
    },
    onRcptTo(addr, _s, cb) {
      if (addr.address.startsWith("bad"))
        return cb(
          Object.assign(new Error("5.1.1 User unknown"), { responseCode: 550 }),
        );
      if (addr.address.startsWith("throttle"))
        return cb(
          Object.assign(new Error("4.7.1 Rate limited, try again later"), {
            responseCode: 451,
          }),
        );
      return cb();
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const to = session.envelope.rcptTo.map((r) => r.address);
        if (to.some((t) => t.startsWith("drop"))) return; // never answer => client times out after DATA (uncertain)
        received.push({ to, raw });
        cb(null, "OK queued");
      });
    },
  });
  return new Promise((r) => smtp.listen(SMTP_PORT, "127.0.0.1", r));
}

async function startApi() {
  api = spawn(
    process.execPath,
    [process.env.E2E_SERVERLESS ? "test/serverless-host.js" : "src/server.js"],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: DB,
        PORT: String(PORT),
        JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-e2e!!",
        ENCRYPTION_KEY: Buffer.from(
          "e2e-key-e2e-key-e2e-key-e2e-key!",
        ).toString("base64"),
        BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
        BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
        PUBLIC_API_URL: BASE,
        CORS_ORIGINS: "http://localhost:5173",
        SMTP_DEV_INSECURE: "1",
        SMTP_TIMEOUT_MS: "3000",
        WORKER_TICK_MS: "300",
        WORKER_IDLE_TICK_MS: "1000",
        STUCK_SENDING_MINUTES: "10",
        LOG_LEVEL: "warn",
        RENDER_INSTANCE_ID: `e2e-${RUN}`,
        SES_API_ENDPOINT: `http://127.0.0.1:${SES_PORT}`,
        SYSTEM_MAIL_USER: "otp@emailspro.test",
        SYSTEM_MAIL_APP_PASSWORD: "pass",
        SYSTEM_MAIL_HOST: "127.0.0.1",
        SYSTEM_MAIL_PORT: String(SMTP_PORT),
        SYSTEM_MAIL_SECURE: "false",
        GEMINI_API_KEY: "e2e-gemini-key",
        GEMINI_BASE_URL: `http://127.0.0.1:${GEM_PORT}`,
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/ready`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await wait(500);
  }
  throw new Error("API did not become ready");
}

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

async function login(email, password) {
  const r = await call("POST", "/api/auth/login", {
    body: { email, password },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body.accessToken, cookie: r.headers.get("set-cookie") };
}

async function waitFor(fn, { timeout = 30000, every = 500 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("waitFor timed out");
    await wait(every);
  }
}

const accountBody = (email) => ({
  email,
  provider: "CUSTOM",
  smtpHost: "127.0.0.1",
  smtpPort: SMTP_PORT,
  smtpSecure: false,
  smtpUser: "user",
  smtpPass: "pass",
  displayName: "E2E Sender",
});

before(async () => {
  if (skip) return;
  await startSmtp();
  await startMockSes();
  await startFakeGemini();
  await startApi();
});

after(async () => {
  if (api) {
    api.kill("SIGTERM");
    await new Promise((r) => api.once("exit", r));
  }
  if (smtp) await new Promise((r) => smtp.close(r));
  if (ses) await new Promise((r) => ses.close(r));
  if (gem) await new Promise((r) => gem.close(r));
});

const ctx = {};

test("health and readiness", { skip }, async () => {
  const h = await call("GET", "/health");
  assert.equal(h.status, 200);
  assert.equal(h.body.app, "Emails Pro");
  assert.ok(
    h.body.version && h.body.timestamp && typeof h.body.uptimeSec === "number",
  );
  const r = await call("GET", "/ready");
  assert.equal(r.body.checks.database.ok, true);
  assert.ok(
    !JSON.stringify(r.body).includes("postgresql://"),
    "no connection details exposed",
  );
});

test("admin creates employees with limits", { skip }, async () => {
  ctx.admin = await login(ADMIN.email, ADMIN.password);
  for (const n of [1, 2]) {
    const r = await call("POST", "/api/admin/employees", {
      token: ctx.admin.token,
      body: {
        email: `emp${n}-${RUN}@example.com`,
        name: `Employee ${n}`,
        password: "EmployeePass123",
        accountLimit: 2,
        hourlyLimit: 3600,
        dailyLimit: 5000,
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ctx[`emp${n}Id`] = r.body.employee.id;
  }
  ctx.emp1 = await login(`emp1-${RUN}@example.com`, "EmployeePass123");
  ctx.emp2 = await login(`emp2-${RUN}@example.com`, "EmployeePass123");
});

test("refresh token rotation + CSRF header required", { skip }, async () => {
  const cookie = ctx.emp1.cookie.split(";")[0];
  const noHeader = await call("POST", "/api/auth/refresh", {
    headers: { Cookie: cookie },
  });
  assert.equal(noHeader.status, 403);
  const ok = await call("POST", "/api/auth/refresh", {
    headers: { Cookie: cookie, "X-Requested-With": "emails-pro" },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.accessToken);
  ctx.emp1.token = ok.body.accessToken;
});

test("wrong SMTP password is rejected before saving", { skip }, async () => {
  const r = await call("POST", "/api/smtp-accounts", {
    token: ctx.emp1.token,
    body: { ...accountBody(`x-${RUN}@example.com`), smtpPass: "wrong" },
  });
  assert.equal(r.status, 400);
  assert.match(
    r.body.error.message,
    /Sending test failed: Authentication failed/,
  );
});

test(
  "account limit is enforced and secrets are never returned",
  { skip },
  async () => {
    const a1 = await call("POST", "/api/smtp-accounts", {
      token: ctx.emp1.token,
      body: accountBody(`sender1-${RUN}@example.com`),
    });
    assert.equal(a1.status, 201, JSON.stringify(a1.body));
    assert.equal(a1.body.account.smtpPassEnc, undefined);
    ctx.acc1 = a1.body.account.id;
    const a2 = await call("POST", "/api/smtp-accounts", {
      token: ctx.emp1.token,
      body: accountBody(`sender2-${RUN}@example.com`),
    });
    assert.equal(a2.status, 201);
    ctx.acc2 = a2.body.account.id;
    const a3 = await call("POST", "/api/smtp-accounts", {
      token: ctx.emp1.token,
      body: accountBody(`sender3-${RUN}@example.com`),
    });
    assert.equal(a3.status, 409);
    assert.equal(a3.body.error.code, "ACCOUNT_LIMIT");
    const list = await call("GET", "/api/smtp-accounts", {
      token: ctx.emp1.token,
    });
    assert.equal(list.body.slots.remaining, 0);
    assert.ok(
      !JSON.stringify(list.body).includes("v1:"),
      "encrypted secrets must not leak",
    );
    // Admin raises the limit => employee can add more
    await call("PATCH", `/api/admin/employees/${ctx.emp1Id}`, {
      token: ctx.admin.token,
      body: { accountLimit: 3 },
    });
    const a3b = await call("POST", "/api/smtp-accounts", {
      token: ctx.emp1.token,
      body: accountBody(`sender3-${RUN}@example.com`),
    });
    assert.equal(a3b.status, 201);
    ctx.acc3 = a3b.body.account.id;
  },
);

test(
  "employees cannot see each other's data; admin cannot create campaigns",
  { skip },
  async () => {
    const r = await call("PATCH", `/api/smtp-accounts/${ctx.acc1}`, {
      token: ctx.emp2.token,
      body: { displayName: "hijack" },
    });
    assert.equal(r.status, 404);
    const adminCreate = await call("POST", "/api/campaigns", {
      token: ctx.admin.token,
      body: {
        name: "x",
        accountId: ctx.acc1,
        listIds: ["x"],
        subject: "s",
        html: "<p>x</p>",
      },
    });
    assert.equal(adminCreate.status, 403);
  },
);

test(
  "campaign sends, classifies failures and records attempts",
  { skip },
  async () => {
    const list = await call("POST", "/api/lists", {
      token: ctx.emp1.token,
      body: { name: "E2E list" },
    });
    ctx.listId = list.body.list.id;
    const contacts = [
      {
        email: `alice-${RUN}@example.org`,
        firstName: "Alice",
        company: "Acme",
      },
      {
        email: `bob-${RUN}@example.org`,
        firstName: "Bob",
        company: "<script>x</script>",
      },
      { email: `carol-${RUN}@example.org`, firstName: "Carol" },
      { email: `bad-${RUN}@example.org` },
      { email: `drop-${RUN}@example.org` },
      { email: "not-an-email" },
      { email: `alice-${RUN}@example.org` },
    ];
    const add = await call("POST", `/api/lists/${ctx.listId}/contacts`, {
      token: ctx.emp1.token,
      body: { contacts, consentSource: "e2e" },
    });
    assert.equal(add.body.added, 5);
    assert.equal(add.body.invalid, 1);
    assert.equal(add.body.duplicates, 1);

    // New accounts start in warm-up (20/day => max 20/hour). Speed is capped accordingly.
    const capped = await call("POST", "/api/campaigns", {
      token: ctx.emp1.token,
      body: {
        name: "too fast",
        accountId: ctx.acc1,
        listIds: [ctx.listId],
        hourlyRate: 3600,
        subject: "x",
        html: "<p>x</p>",
      },
    });
    assert.equal(capped.status, 400);
    assert.match(capped.body.error.message, /20 emails\/hour/);
    const w = await call("PATCH", `/api/admin/accounts/${ctx.acc1}`, {
      token: ctx.admin.token,
      body: { warmupEnabled: false },
    });
    assert.equal(w.status, 200);

    const c = await call("POST", "/api/campaigns", {
      token: ctx.emp1.token,
      body: {
        name: "E2E fresh",
        accountId: ctx.acc1,
        listIds: [ctx.listId],
        hourlyRate: 3600,
        subject: "Hello {{firstName}}",
        html: '<p>Hi {{firstName}} at {{companyName}}</p><a href="https://example.com/page?a=1&b=2">Link</a><script>alert(1)</script>',
      },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    ctx.campaignId = c.body.campaign.id;
    assert.ok(
      !c.body.campaign.html.includes("<script>"),
      "HTML must be sanitized",
    );

    const start = await call("POST", `/api/campaigns/${ctx.campaignId}/start`, {
      token: ctx.emp1.token,
      body: {},
    });
    assert.equal(start.body.status, "SENDING");

    const done = await waitFor(
      async () => {
        const d = await call("GET", `/api/campaigns/${ctx.campaignId}`, {
          token: ctx.emp1.token,
        });
        const s = d.body.campaign.stats;
        return s.pending === 0 &&
          s.sending === 0 &&
          d.body.campaign.status === "COMPLETED"
          ? d.body.campaign
          : null;
      },
      { timeout: 45000 },
    );
    assert.equal(done.stats.sent, 3);
    assert.equal(done.stats.bounced, 1, "invalid recipient => bounced");
    assert.equal(
      done.stats.unknown,
      1,
      "dropped connection after DATA => UNKNOWN, never auto-resent",
    );
    assert.equal(done.status, "COMPLETED");

    const bob = received.find((m) => m.to[0].startsWith("bob"));
    assert.ok(bob, "bob received");
    assert.ok(
      bob.raw.includes("&lt;script&gt;"),
      "personalisation values are HTML-escaped",
    );
    assert.match(bob.raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
    assert.match(bob.raw, /\/t\/c\//, "links are click-tracked");
    const supp = await call("GET", "/api/suppressions", {
      token: ctx.emp1.token,
    });
    assert.ok(
      supp.body.items.some(
        (s) => s.email.startsWith("bad") && s.reason === "INVALID",
      ),
    );
    const hist = await call(
      "GET",
      `/api/reports/history?campaignId=${ctx.campaignId}`,
      { token: ctx.emp1.token },
    );
    assert.ok(hist.body.total >= 5);
  },
);

test("tracking + one-click unsubscribe", { skip }, async () => {
  const recips = await call(
    "GET",
    `/api/campaigns/${ctx.campaignId}/recipients?status=SENT`,
    { token: ctx.emp1.token },
  );
  const alice = recips.body.items.find((r) => r.email.startsWith("alice"));
  const raw = received
    .find((m) => m.to[0].startsWith("alice"))
    .raw.replace(/=\r?\n/g, "")
    .replace(/=3D/g, "=");
  const token = raw.match(/\/u\/([A-Za-z0-9_-]+)/)[1];
  const click = raw.match(/\/t\/c\/[^"\s]+/)[0].replace(/&amp;/g, "&");
  const ok = await fetch(`${BASE}${click}`, {
    redirect: "manual",
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "https://example.com/page?a=1&b=2");
  const tampered = await fetch(
    `${BASE}${click.replace("example.com", "evil.com")}`,
    { redirect: "manual" },
  );
  assert.equal(tampered.status, 400, "open-redirect protection");
  const pix = await fetch(`${BASE}/t/o/${token}.gif`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  assert.equal(pix.headers.get("content-type"), "image/gif");

  const get = await fetch(`${BASE}/u/${token}`);
  assert.match(await get.text(), /Unsubscribe/);
  const post = await fetch(`${BASE}/u/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  assert.equal(post.status, 200);
  await wait(300);
  const after2 = await call(
    "GET",
    `/api/campaigns/${ctx.campaignId}/recipients?search=alice`,
    { token: ctx.emp1.token },
  );
  assert.ok(after2.body.items[0].unsubscribedAt);
  assert.ok(after2.body.items[0].clickCount >= 1, "click recorded");
  // A click seconds after delivery is treated as a probable security-scanner click: counted, but not "clicked".
  assert.equal(after2.body.items[0].clickedAt, null);
  ctx.aliceId = alice.id;
});

test(
  "follow-up uses original sender + threading, excludes unsubscribed/bounced",
  { skip },
  async () => {
    const elig = await call(
      "GET",
      `/api/campaigns/${ctx.campaignId}/follow-up/eligible`,
      { token: ctx.emp1.token },
    );
    assert.equal(
      elig.body.total,
      2,
      "alice (unsubscribed), bad (bounced), drop (unknown) excluded",
    );
    const before2 = received.length;
    const f = await call("POST", `/api/campaigns/${ctx.campaignId}/follow-up`, {
      token: ctx.emp1.token,
      body: {
        name: "E2E follow-up",
        hourlyRate: 3600,
        html: "<p>Just following up, {{firstName}}</p>",
        subject: "unused",
      },
    });
    assert.equal(f.status, 201, JSON.stringify(f.body));
    await call("POST", `/api/campaigns/${f.body.campaign.id}/start`, {
      token: ctx.emp1.token,
      body: {},
    });
    await waitFor(() => received.length >= before2 + 2, { timeout: 30000 });
    const fu = received.slice(before2).find((m) => m.to[0].startsWith("bob"));
    assert.match(fu.raw, /In-Reply-To: </);
    assert.match(fu.raw, /Subject: Re: Hello Bob/);
    assert.match(fu.raw, /From: .*sender1-/);
  },
);

test(
  "inbox: reply from the same mailbox in-thread, lead status, auto-reply ignored, response report",
  { skip },
  async () => {
    const pg = (await import("pg")).default;
    const db = new pg.Client({ connectionString: DB });
    await db.connect();
    try {
      const {
        rows: [bob],
      } = await db.query(
        `SELECT r.id, r."messageId", r.email, c."ownerId" FROM "CampaignRecipient" r JOIN "Campaign" c ON c.id = r."campaignId" WHERE r."campaignId" = $1 AND r.email LIKE 'bob%'`,
        [ctx.campaignId],
      );
      const ins = async (id, extra = {}) =>
        db.query(
          `INSERT INTO "EmailMessage" (id, "ownerId", "accountId", "recipientId", "campaignId", direction, "messageId", "inReplyTo", "fromAddr", "toAddr", subject, text, "isAutoReply") VALUES ($1,$2,$3,$4,$5,'INBOUND',$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            bob.ownerId,
            ctx.acc1,
            bob.id,
            ctx.campaignId,
            `<${id}@example.org>`,
            bob.messageId,
            bob.email,
            "sender1@example.com",
            extra.subject || "Re: Hello Bob",
            extra.text || "Sounds good, can we talk Monday?",
            !!extra.auto,
          ],
        );
      await ins(`in-${RUN}`);
      await ins(`ooo-${RUN}`, {
        auto: true,
        subject: "Out of office",
        text: "I am away",
      });

      const other = await call("POST", `/api/inbox/in-${RUN}/reply`, {
        token: ctx.emp2.token,
        body: { html: "<p>hi</p>" },
      });
      assert.equal(
        other.status,
        404,
        "cannot reply to another employee's message",
      );
      const empty = await call("POST", `/api/inbox/in-${RUN}/reply`, {
        token: ctx.emp1.token,
        body: { html: "<p> </p>" },
      });
      assert.equal(empty.status, 400);

      const before2 = received.length;
      const r = await call("POST", `/api/inbox/in-${RUN}/reply`, {
        token: ctx.emp1.token,
        body: { html: "<p>Monday at 11 works.</p><script>alert(1)</script>" },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const mail = (
        await waitFor(() =>
          received.slice(before2).find((m) => m.to.includes(bob.email)),
        )
      ).raw;
      assert.match(mail, new RegExp(`In-Reply-To: <in-${RUN}@example.org>`));
      assert.match(mail, /Subject: Re: Hello Bob/);
      assert.match(
        mail,
        /From: .*sender1-/,
        "sent from the mailbox that received the reply",
      );
      assert.doesNotMatch(mail, /<script/);

      const detail = await call("GET", `/api/inbox/in-${RUN}`, {
        token: ctx.emp1.token,
      });
      assert.equal(detail.status, 200);
      assert.ok(
        JSON.stringify(detail.body).includes("YOU_REPLIED"),
        "our reply shows in the thread",
      );

      const s = await call("POST", `/api/inbox/in-${RUN}/status`, {
        token: ctx.emp1.token,
        body: { leadStatus: "INTERESTED" },
      });
      assert.equal(s.status, 200, JSON.stringify(s.body));
      const bad = await call("POST", `/api/inbox/in-${RUN}/status`, {
        token: ctx.emp1.token,
        body: { leadStatus: "HOT" },
      });
      assert.equal(bad.status, 400);
      const interested = await call("GET", "/api/inbox?lead=interested", {
        token: ctx.emp1.token,
      });
      assert.ok(interested.body.items.some((i) => i.id === `in-${RUN}`));

      const rep = await call("GET", "/api/reports/responses?days=30", {
        token: ctx.emp1.token,
      });
      assert.equal(rep.status, 200, JSON.stringify(rep.body));
      assert.ok(
        Array.isArray(rep.body.pitches) && Array.isArray(rep.body.subjects),
      );
      assert.ok(rep.body.subjects.some((x) => x.sent > 0));

      // AI reply draft sends only the client's message, and works for the owner only.
      const d = await call("POST", "/api/ai/reply-draft", {
        token: ctx.emp1.token,
        body: { messageId: `in-${RUN}`, intent: "meeting" },
      });
      assert.equal(d.status, 200, JSON.stringify(d.body));
      assert.match(d.body.text, /Monday/);
      const d2 = await call("POST", "/api/ai/reply-draft", {
        token: ctx.emp2.token,
        body: { messageId: `in-${RUN}`, intent: "meeting" },
      });
      assert.equal(d2.status, 404);
    } finally {
      await db.end();
    }
  },
);

test(
  "Gemini free-tier guard: per-user daily cap, cache, 429 cool-down, admin switch",
  { skip },
  async () => {
    const st = await call("GET", "/api/ai/status", { token: ctx.emp1.token });
    assert.equal(st.status, 200);
    assert.equal(st.body.enabled, true, JSON.stringify(st.body));
    const adminTry = await call("POST", "/api/ai/pitch-review", {
      token: ctx.admin.token,
      body: { subjects: ["Hi"], html: "<p>Hello</p>" },
    });
    assert.equal(adminTry.status, 403, "AI tools are for employees");

    await call("PUT", "/api/admin/settings", {
      token: ctx.admin.token,
      body: { aiUserDailyLimit: 2 },
    });
    const review = (n) =>
      call("POST", "/api/ai/pitch-review", {
        token: ctx.emp2.token,
        body: {
          subjects: [`Hello ${n}`],
          html: `<p>Hi {{firstName}}, pitch number ${n}. Would a quick call help?</p>`,
        },
      });
    const c0 = gemini.calls;
    const a = await review(1);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.score, 70);
    const again = await review(1);
    assert.equal(again.status, 200);
    assert.equal(
      gemini.calls,
      c0 + 1,
      "identical request served from cache, not Google",
    );
    assert.equal((await review(2)).status, 200);
    const capped = await review(3);
    assert.equal(capped.status, 429, "per-user daily cap reached");
    assert.equal(gemini.calls, c0 + 2);
    await call("PUT", "/api/admin/settings", {
      token: ctx.admin.token,
      body: { aiUserDailyLimit: 30, aiPerMinute: 60 },
    });

    const imp = await call("POST", "/api/ai/improve-pitch", {
      token: ctx.emp1.token,
      body: {
        html: "<p>Hello {{firstName}} long pitch We help manufacturing teams cut reporting time in half. Would a short call next week be useful?</p>",
        goal: "shorter",
      },
    });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.doesNotMatch(imp.body.html, /<script/, "AI output is sanitised");

    assert.equal(
      gemini.last.generationConfig.thinkingConfig?.thinkingLevel,
      "LOW",
      "thinking kept low so answers are quick",
    );
    assert.ok(
      gemini.last.generationConfig.maxOutputTokens > 1500,
      "room left for thinking tokens",
    );

    gemini.mode = "503once";
    const flaky = await call("POST", "/api/ai/improve-pitch", {
      token: ctx.emp1.token,
      body: {
        html: "<p>Overloaded once {{firstName}} We help manufacturing teams cut reporting time in half. Would a short call next week be useful?</p>",
        goal: "friendlier",
      },
    });
    assert.equal(
      flaky.status,
      200,
      `one retry after Google 503: ${JSON.stringify(flaky.body)}`,
    );
    assert.match(
      gemini.lastPath,
      /gemini-flash-lite-latest:generateContent/,
      "busy main model -> backup model answers",
    );
    gemini.mode = "503";
    const down = await call("POST", "/api/ai/improve-pitch", {
      token: ctx.emp1.token,
      body: {
        html: "<p>Overloaded twice {{firstName}} We help manufacturing teams cut reporting time in half. Would a short call next week be useful?</p>",
        goal: "friendlier",
      },
    });
    assert.equal(down.status, 503);
    assert.match(down.body.error.message, /overloaded/i);
    gemini.mode = "nothink";
    const old = await call("POST", "/api/ai/improve-pitch", {
      token: ctx.emp1.token,
      body: {
        html: "<p>Older model {{firstName}} We help manufacturing teams cut reporting time in half. Would a short call next week be useful?</p>",
        goal: "grammar",
      },
    });
    assert.equal(
      old.status,
      200,
      `falls back for models without thinking: ${JSON.stringify(old.body)}`,
    );
    assert.equal(gemini.last.generationConfig.thinkingConfig, undefined);
    gemini.mode = "ok";

    gemini.mode = "429";
    const limited = await call("POST", "/api/ai/improve-pitch", {
      token: ctx.emp1.token,
      body: {
        html: "<p>Another {{firstName}} We help manufacturing teams cut reporting time in half. Would a short call next week be useful?</p>",
        goal: "formal",
      },
    });
    assert.equal(limited.status, 429);
    const calls = gemini.calls;
    const cooled = await call("POST", "/api/ai/improve-pitch", {
      token: ctx.emp1.token,
      body: {
        html: "<p>Third {{firstName}} We help manufacturing teams cut reporting time in half. Would a short call next week be useful?</p>",
        goal: "formal",
      },
    });
    assert.equal(cooled.status, 429);
    assert.equal(
      gemini.calls,
      calls,
      "during cool-down we do not call Google at all",
    );
    gemini.mode = "ok";

    await call("PUT", "/api/admin/settings", {
      token: ctx.admin.token,
      body: { aiEnabled: false },
    });
    const off = await call("POST", "/api/ai/improve-pitch", {
      token: ctx.emp1.token,
      body: {
        html: "<p>x {{firstName}} We help manufacturing teams cut reporting time in half. Would a short call next week be useful?</p>",
        goal: "grammar",
      },
    });
    assert.ok(
      [403, 409, 503].includes(off.status),
      `disabled -> ${off.status}`,
    );
    await call("PUT", "/api/admin/settings", {
      token: ctx.admin.token,
      body: { aiEnabled: true, aiUserDailyLimit: 30, aiPerMinute: 8 },
    });
  },
);

test(
  "several mailboxes: recipients split evenly, names filled in, sender signs with account name",
  { skip },
  async () => {
    const list = await call("POST", "/api/lists", {
      token: ctx.emp1.token,
      body: { name: `Multi ${RUN}` },
    });
    const contacts = [
      { email: `ravi.kumar.m${RUN}@example.org` }, // name only from the address
      { email: `meera.m${RUN}@example.org`, firstName: "Meera" },
      { email: `m3-${RUN}@example.org` },
      { email: `m4-${RUN}@example.org` },
      { email: `m5-${RUN}@example.org` },
      { email: `m6-${RUN}@example.org` },
    ];
    await call("POST", `/api/lists/${list.body.list.id}/contacts`, {
      token: ctx.emp1.token,
      body: { contacts },
    });
    await call("PATCH", `/api/smtp-accounts/${ctx.acc2}`, {
      token: ctx.emp1.token,
      body: { displayName: "Sales Two", groupName: "Zoho team" },
    });
    for (const id of [ctx.acc1, ctx.acc2, ctx.acc3]) {
      await call("PATCH", `/api/admin/accounts/${id}`, {
        token: ctx.admin.token,
        body: { warmupEnabled: false, maxHourly: 3600, maxDaily: 5000 },
      });
    }
    const c = await call("POST", "/api/campaigns", {
      token: ctx.emp1.token,
      body: {
        name: "Multi",
        accountIds: [ctx.acc1, ctx.acc2],
        listIds: [list.body.list.id],
        hourlyRate: 3600,
        subject: "Hello {{First Name|there}}",
        html: "<p>Hi {{firstName}} {{lastName}},</p><p>Regards,<br>{{senderName}}</p>",
      },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const id = c.body.campaign.id;
    const d = await call("GET", `/api/campaigns/${id}`, {
      token: ctx.emp1.token,
    });
    assert.deepEqual(
      d.body.accounts.map((a) => a.total),
      [3, 3],
      "6 recipients over 2 mailboxes = 3 each",
    );
    const before = received.length;
    await call("POST", `/api/campaigns/${id}/start`, {
      token: ctx.emp1.token,
      body: {},
    });
    await waitFor(
      async () =>
        (await call("GET", `/api/campaigns/${id}`, { token: ctx.emp1.token }))
          .body.campaign.status === "COMPLETED",
      { timeout: 45000 },
    );
    const mine = received
      .slice(before)
      .map((m) => m.raw.replace(/=\r?\n/g, ""));
    assert.equal(mine.length, 6);
    assert.equal(mine.filter((r) => /From: .*sender1-/.test(r)).length, 3);
    assert.equal(mine.filter((r) => /From: .*sender2-/.test(r)).length, 3);
    const ravi = mine.find((r) => r.includes(`ravi.kumar.m${RUN}`));
    assert.match(
      ravi,
      /Hi Ravi Kumar,/,
      "first and last name guessed from the address",
    );
    assert.match(
      ravi,
      /Subject: Hello Ravi/,
      "variable names are matched loosely ({{First Name}})",
    );
    const two = mine.find((r) => /From: .*sender2-/.test(r));
    assert.match(
      two,
      /Sales Two/,
      "{{senderName}} = the sending account's sender name",
    );
    ctx.multiCampaign = id;
  },
);

test(
  "fresh campaign moves unsent recipients off a disabled mailbox; follow-ups never switch sender",
  { skip },
  async () => {
    const list = await call("POST", "/api/lists", {
      token: ctx.emp1.token,
      body: { name: `Failover ${RUN}` },
    });
    const contacts = Array.from({ length: 4 }, (_, i) => ({
      email: `fo${i}-${RUN}@example.org`,
    }));
    await call("POST", `/api/lists/${list.body.list.id}/contacts`, {
      token: ctx.emp1.token,
      body: { contacts },
    });
    const c = await call("POST", "/api/campaigns", {
      token: ctx.emp1.token,
      body: {
        name: "Failover",
        accountIds: [ctx.acc3, ctx.acc1],
        listIds: [list.body.list.id],
        hourlyRate: 3600,
        subject: "S",
        html: "<p>x</p>",
      },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    // The admin disables sender3 before sending starts: its 2 recipients must go out from sender1 instead.
    await call("POST", "/api/admin/emergency", {
      token: ctx.admin.token,
      body: { scope: "account", id: ctx.acc3, stop: true },
    });
    const before = received.length;
    await call("POST", `/api/campaigns/${c.body.campaign.id}/start`, {
      token: ctx.emp1.token,
      body: {},
    });
    await waitFor(
      async () =>
        (
          await call("GET", `/api/campaigns/${c.body.campaign.id}`, {
            token: ctx.emp1.token,
          })
        ).body.campaign.status === "COMPLETED",
      { timeout: 45000 },
    );
    const mine = received.slice(before);
    assert.equal(mine.length, 4, "all 4 delivered");
    assert.ok(
      mine.every((m) => /From: .*sender1-/.test(m.raw)),
      "all sent by the working mailbox",
    );

    // Follow-up of the multi-account campaign while sender2 is disabled: sender2's recipients FAIL, never switch.
    await call("POST", "/api/admin/emergency", {
      token: ctx.admin.token,
      body: { scope: "account", id: ctx.acc2, stop: true },
    });
    const f = await call(
      "POST",
      `/api/campaigns/${ctx.multiCampaign}/follow-up`,
      {
        token: ctx.emp1.token,
        body: {
          name: "Strict FU",
          hourlyRate: 3600,
          html: "<p>Following up</p>",
          subject: "x",
        },
      },
    );
    assert.equal(f.status, 201, JSON.stringify(f.body));
    const b2 = received.length;
    await call("POST", `/api/campaigns/${f.body.campaign.id}/start`, {
      token: ctx.emp1.token,
      body: {},
    });
    const done = await waitFor(
      async () => {
        const d = await call("GET", `/api/campaigns/${f.body.campaign.id}`, {
          token: ctx.emp1.token,
        });
        return d.body.campaign.status === "COMPLETED" ? d.body : null;
      },
      { timeout: 45000 },
    );
    const fu = received.slice(b2);
    assert.equal(
      fu.length,
      3,
      "only sender1's original recipients got the follow-up",
    );
    assert.ok(fu.every((m) => /From: .*sender1-/.test(m.raw)));
    assert.equal(
      done.campaign.stats.failed,
      3,
      "sender2's recipients failed instead of switching mailbox",
    );
    const failed = await call(
      "GET",
      `/api/campaigns/${f.body.campaign.id}/recipients?status=FAILED`,
      { token: ctx.emp1.token },
    );
    assert.match(failed.body.items[0].lastError, /original sender/);
    await call("POST", "/api/admin/emergency", {
      token: ctx.admin.token,
      body: { scope: "account", id: ctx.acc2, stop: false },
    });
    await call("POST", "/api/admin/emergency", {
      token: ctx.admin.token,
      body: { scope: "account", id: ctx.acc3, stop: false },
    });
    // Account groups can be set for many mailboxes at once.
    const g = await call("POST", "/api/smtp-accounts/group", {
      token: ctx.emp1.token,
      body: { ids: [ctx.acc1, ctx.acc3], groupName: "Gmail team" },
    });
    assert.equal(g.body.updated, 2);
    const accs = await call("GET", "/api/smtp-accounts", {
      token: ctx.emp1.token,
    });
    assert.equal(
      accs.body.accounts.find((a) => a.id === ctx.acc1).groupName,
      "Gmail team",
    );
  },
);

test(
  "pitch with several subject lines rotates them across recipients",
  { skip },
  async () => {
    const pitch = await call("POST", "/api/pitches", {
      token: ctx.emp1.token,
      body: {
        name: "Rotating",
        subjects: ["A {{firstName}}", "B", "C"],
        html: '<div style="font-family:Arial"><p style="margin:0 0 16px 0">Hi</p><ul><li style="margin:0 0 6px 0">One</li></ul></div>',
      },
    });
    assert.equal(pitch.status, 201);
    assert.match(pitch.body.pitch.latest.text, /Hi\n\n• One/);
    const c = await call("POST", "/api/campaigns", {
      token: ctx.emp1.token,
      body: {
        name: "Rotate",
        accountId: ctx.acc2,
        listIds: [ctx.listId],
        hourlyRate: 10,
        pitchVersionId: pitch.body.pitch.latest.id,
        rotateSubjects: true,
      },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const r = await call(
      "GET",
      `/api/campaigns/${c.body.campaign.id}/recipients?pageSize=100`,
      { token: ctx.emp1.token },
    );
    const subjects = r.body.items.map((x) => x.subject);
    assert.ok(subjects.length >= 3);
    assert.deepEqual(subjects.slice(0, 3), ["A {{firstName}}", "B", "C"]);
    assert.equal(subjects[3] ?? "A {{firstName}}", "A {{firstName}}");
    // Switching rotation off clears per-recipient subjects (campaign subject applies again).
    const off = await call("PATCH", `/api/campaigns/${c.body.campaign.id}`, {
      token: ctx.emp1.token,
      body: { rotateSubjects: false },
    });
    assert.equal(off.status, 200);
    const r2 = await call(
      "GET",
      `/api/campaigns/${c.body.campaign.id}/recipients?pageSize=100`,
      { token: ctx.emp1.token },
    );
    assert.ok(r2.body.items.every((x) => x.subject === null));
    assert.equal(
      (
        await call("DELETE", `/api/campaigns/${c.body.campaign.id}`, {
          token: ctx.emp1.token,
        })
      ).status < 300,
      true,
    );
  },
);

test("working-campaign limit (7) blocks the 8th", { skip }, async () => {
  const mk = (i) =>
    call("POST", "/api/campaigns", {
      token: ctx.emp1.token,
      body: {
        name: `Draft ${i}`,
        accountId: ctx.acc2,
        listIds: [ctx.listId],
        hourlyRate: 10,
        subject: "S",
        html: "<p>x</p>",
      },
    });
  // fresh(COMPLETED) + follow-up(SENDING/COMPLETED) already exist; create drafts until blocked
  const statuses = [];
  for (let i = 0; i < 8; i += 1) statuses.push((await mk(i)).status);
  const working = await call("GET", "/api/campaigns", {
    token: ctx.emp1.token,
  });
  assert.ok(working.body.working.count <= 7);
  assert.equal(statuses.at(-1), 409);
});

test(
  "shared account limiter + admin pause + emergency stop",
  { skip },
  async () => {
    // Admin caps account 2 at 2/hour; a campaign must not exceed it.
    await call("PATCH", `/api/admin/accounts/${ctx.acc2}`, {
      token: ctx.admin.token,
      body: { maxHourly: 2 },
    });
    const list = await call("GET", "/api/campaigns?pageSize=50", {
      token: ctx.emp1.token,
    });
    const draft = list.body.items.find(
      (c) => c.status === "DRAFT" && c.accountId === ctx.acc2,
    );
    const tooFast = await call("PATCH", `/api/campaigns/${draft.id}`, {
      token: ctx.emp1.token,
      body: { hourlyRate: 100 },
    });
    assert.equal(
      tooFast.status,
      400,
      "employee speed cannot exceed admin account max",
    );
    await call("PATCH", `/api/campaigns/${draft.id}`, {
      token: ctx.emp1.token,
      body: { hourlyRate: 2 },
    });
    const before3 = received.length;
    await call("POST", `/api/campaigns/${draft.id}/start`, {
      token: ctx.emp1.token,
      body: {},
    });
    await wait(4000);
    const sent = received.slice(before3).length;
    assert.ok(
      sent <= 1,
      `at most one send in the first pacing interval, got ${sent}`,
    );

    const p = await call("POST", `/api/admin/campaigns/${draft.id}/pause`, {
      token: ctx.admin.token,
      body: { reason: "review" },
    });
    assert.equal(p.status, 200);
    const resume = await call("POST", `/api/campaigns/${draft.id}/resume`, {
      token: ctx.emp1.token,
    });
    assert.equal(resume.status, 403, "employee cannot override admin pause");

    const e = await call("POST", "/api/admin/emergency", {
      token: ctx.admin.token,
      body: { scope: "global", stop: true },
    });
    assert.equal(e.status, 200);
    const dash = await call("GET", "/api/admin/dashboard", {
      token: ctx.admin.token,
    });
    assert.equal(dash.body.globalSendingPaused, true);
    await call("POST", "/api/admin/emergency", {
      token: ctx.admin.token,
      body: { scope: "global", stop: false },
    });
  },
);

test(
  "monitoring endpoint reports worker and queue state",
  { skip },
  async () => {
    const m = await call("GET", "/api/admin/monitoring", {
      token: ctx.admin.token,
    });
    assert.equal(m.status, 200);
    assert.equal(m.body.database.ok, true);
    assert.equal(m.body.worker.leader, true);
    assert.ok(m.body.queue.unknownSends >= 1);
    const forbidden = await call("GET", "/api/admin/monitoring", {
      token: ctx.emp1.token,
    });
    assert.equal(forbidden.status, 403);
  },
);

test(
  "Amazon SES API transport (HTTPS, works on Render Free) sends signed requests",
  { skip },
  async () => {
    const acc = await call("POST", "/api/smtp-accounts", {
      token: ctx.emp2.token,
      body: {
        sendMethod: "SES_API",
        sesRegion: "ap-south-1",
        email: `ses-${RUN}@example.com`,
        smtpUser: "AKIATEST",
        smtpPass: "secret-key",
        displayName: "SES sender",
      },
    });
    assert.equal(acc.status, 201, JSON.stringify(acc.body));
    assert.equal(acc.body.tests.smtp.via, "Amazon SES API (HTTPS)");
    const bad = await call("POST", "/api/smtp-accounts", {
      token: ctx.emp2.token,
      body: {
        sendMethod: "SES_API",
        sesRegion: "mars-1",
        email: `x-${RUN}@example.com`,
        smtpUser: "AKIATEST",
        smtpPass: "s",
      },
    });
    assert.equal(bad.status, 400, "invalid region rejected");
    await call("PATCH", `/api/admin/accounts/${acc.body.account.id}`, {
      token: ctx.admin.token,
      body: { warmupEnabled: false },
    });
    const list = await call("POST", "/api/lists", {
      token: ctx.emp2.token,
      body: { name: "SES list" },
    });
    await call("POST", `/api/lists/${list.body.list.id}/contacts`, {
      token: ctx.emp2.token,
      body: {
        contacts: [{ email: `dana-${RUN}@example.org`, firstName: "Dana" }],
      },
    });
    const c = await call("POST", "/api/campaigns", {
      token: ctx.emp2.token,
      body: {
        name: "SES campaign",
        accountId: acc.body.account.id,
        listIds: [list.body.list.id],
        hourlyRate: 60,
        subject: "Hi {{firstName}}",
        html: "<p>Hello</p>",
      },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const st = await call(
      "POST",
      `/api/campaigns/${c.body.campaign.id}/start`,
      { token: ctx.emp2.token, body: {} },
    );
    assert.equal(st.body.status, "SENDING");
    const rec = await waitFor(async () => {
      const r = await call(
        "GET",
        `/api/campaigns/${c.body.campaign.id}/recipients`,
        { token: ctx.emp2.token },
      );
      return r.body.items[0]?.status === "SENT" ? r.body.items[0] : null;
    });
    const sendCall = sesCalls.find((x) => x.method === "POST");
    const raw = Buffer.from(
      JSON.parse(sendCall.body).Content.Raw.Data,
      "base64",
    ).toString("utf8");
    assert.match(raw, /Subject: Hi Dana/);
    assert.match(raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
    assert.match(
      sendCall.auth,
      /Credential=AKIATEST\/\d{8}\/ap-south-1\/ses\/aws4_request/,
    );
    assert.ok(rec.sentAt);
  },
);

const codeFor = async (to, after) => {
  const m = await waitFor(
    () => received.slice(after).find((x) => x.to.includes(to)),
    { timeout: 10000, every: 200 },
  );
  return m.raw.match(/Subject: (\d{6}) is your Emails Pro/)[1];
};

test(
  "email OTP login: admin toggle, wrong code, resend cooldown, success",
  { skip },
  async () => {
    const opts = await call("GET", "/api/auth/options");
    assert.equal(opts.body.otpLogin, false);
    assert.equal(opts.body.passwordReset, true);
    const on = await call("PUT", "/api/admin/settings", {
      token: ctx.admin.token,
      body: { otpLoginEnabled: true },
    });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(
      on.body.settings.systemMailRefreshEnc,
      undefined,
      "mailbox secret never returned",
    );

    const email = `emp2-${RUN}@example.com`;
    const before = received.length;
    const step1 = await call("POST", "/api/auth/login", {
      body: { email, password: "EmployeePass123", remember: false },
    });
    assert.equal(step1.status, 200);
    assert.equal(step1.body.otpRequired, true);
    assert.equal(step1.body.accessToken, undefined, "no session before OTP");
    assert.match(step1.body.email, /^em•+@example\.com$/);
    const code = await codeFor(email, before);

    const wrong = await call("POST", "/api/auth/login/verify", {
      body: {
        challengeId: step1.body.challengeId,
        code: code === "000000" ? "111111" : "000000",
      },
    });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error.message, /attempts left/);
    const resend = await call("POST", "/api/auth/login/resend", {
      body: { challengeId: step1.body.challengeId },
    });
    assert.equal(resend.status, 429, "resend cooldown enforced");

    const ok = await call("POST", "/api/auth/login/verify", {
      body: { challengeId: step1.body.challengeId, code },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.accessToken);
    assert.ok(
      !/Max-Age/i.test(ok.headers.get("set-cookie")),
      '"Remember me" off => session cookie',
    );
    const reuse = await call("POST", "/api/auth/login/verify", {
      body: { challengeId: step1.body.challengeId, code },
    });
    assert.equal(reuse.status, 400, "a code works once");

    // Admins are exempt unless otpForAdmins is on
    const adminLogin = await call("POST", "/api/auth/login", {
      body: { email: ADMIN.email, password: ADMIN.password },
    });
    assert.ok(adminLogin.body.accessToken);
    await call("PUT", "/api/admin/settings", {
      token: ctx.admin.token,
      body: { otpLoginEnabled: false },
    });
  },
);

test(
  "forgot password: emailed code resets password and revokes sessions",
  { skip },
  async () => {
    const email = `emp1-${RUN}@example.com`;
    const unknown = await call("POST", "/api/auth/password/forgot", {
      body: { email: `nobody-${RUN}@example.com` },
    });
    assert.equal(unknown.status, 200, "no account enumeration");
    const before = received.length;
    const f = await call("POST", "/api/auth/password/forgot", {
      body: { email },
    });
    assert.equal(f.status, 200);
    const raw = (
      await waitFor(() =>
        received.slice(before).find((x) => x.to.includes(email)),
      )
    ).raw;
    const code = raw.match(
      /Subject: (\d{6}) is your Emails Pro password reset code/,
    )[1];
    const bad = await call("POST", "/api/auth/password/reset", {
      body: {
        email,
        code: "999999" === code ? "111111" : "999999",
        newPassword: "BrandNewPass456",
      },
    });
    assert.equal(bad.status, 400);
    const r = await call("POST", "/api/auth/password/reset", {
      body: { email, code, newPassword: "BrandNewPass456" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const old = await call("GET", "/api/smtp-accounts", {
      token: ctx.emp1.token,
    });
    assert.equal(old.status, 401, "existing sessions revoked");
    const relog = await call("POST", "/api/auth/login", {
      body: { email, password: "BrandNewPass456" },
    });
    assert.ok(relog.body.accessToken);
  },
);
