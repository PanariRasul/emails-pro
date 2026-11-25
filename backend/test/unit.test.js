import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString("base64");
process.env.JWT_SECRET ||= "unit-test-secret-unit-test-secret-1234";

const { encryptSecret, decryptSecret, hmac } =
  await import("../src/lib/crypto.js");
const { TtlCache } = await import("../src/lib/cache.js");
const {
  accountLimits,
  employeeLimits,
  intervalMs,
  warmupProgress,
  speedOptions,
} = await import("../src/services/limits.js");
const { classifySmtpError } = await import("../src/services/smtp.js");
const {
  renderTemplate,
  sanitizeEmailHtml,
  buildMessage,
  verifyClick,
  clickUrl,
} = await import("../src/services/template.js");

const settings = {
  defaultAccountLimit: 100,
  maxAccountLimit: 500,
  defaultDailyLimit: 500,
  defaultHourlyLimit: 60,
  maxEmployeeDailyLimit: 5000,
  warmupStartPercent: 20,
  warmupDays: 10,
  trackingEnabled: true,
  footerHtml: '<a href="{{unsubscribeUrl}}">Unsubscribe</a>',
  footerText: "Unsubscribe: {{unsubscribeUrl}}",
};

test("AES-256-GCM round trip, random IV, tamper detection", () => {
  const a = encryptSecret("app-password");
  const b = encryptSecret("app-password");
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), "app-password");
  const parts = a.split(":");
  parts[4] = Buffer.from("tampered").toString("base64");
  assert.throws(() => decryptSecret(parts.join(":")));
});

test("lowest applicable limit wins", () => {
  const owner = { hourlyLimit: 60, dailyLimit: 500, accountLimit: null };
  assert.deepEqual(employeeLimits(owner, settings), {
    hourly: 60,
    daily: 500,
    accounts: 100,
  });
  const acc = {
    maxHourly: 30,
    maxDaily: 1000,
    warmupEnabled: false,
    consecutiveFailures: 0,
  };
  const l = accountLimits(acc, owner, settings);
  assert.equal(l.hourly, 30);
  assert.equal(l.daily, 500, "employee daily caps the account");
  // employee daily can never exceed the system maximum
  assert.equal(employeeLimits({ dailyLimit: 99_999 }, settings).daily, 5000);
});

test("warm-up: 20% of the normal limits on day 1, full limits from day 10, badge turns off", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const acc = {
    warmupEnabled: true,
    warmupStartedAt: start,
    consecutiveFailures: 0,
  };
  const owner = { hourlyLimit: 60, dailyLimit: 500 };
  const on = (d) =>
    accountLimits(acc, owner, settings, new Date(Date.UTC(2026, 0, d, 12)));
  assert.deepEqual(
    [on(1).daily, on(1).hourly],
    [100, 12],
    "day 1 = 20% of 500/day and 60/hour",
  );
  assert.deepEqual(on(1).warmup, { day: 1, totalDays: 10, percent: 20 });
  assert.equal(on(5).daily, 277, "day 5 ≈ 55.6%");
  assert.equal(on(9).daily, 455);
  assert.equal(on(10).daily, 500, "day 10 = full limit");
  assert.equal(
    on(10).warmupActive,
    false,
    "warm-up badge disappears when finished",
  );
  assert.equal(on(30).hourly, 60);
  // Admin overrides per account: 50% over 4 days.
  const fast = accountLimits(
    { ...acc, warmupStartPercent: 50, warmupDays: 4 },
    owner,
    settings,
    new Date("2026-01-02T12:00:00Z"),
  );
  assert.equal(fast.daily, 333);
  assert.equal(warmupProgress({ warmupEnabled: false }, settings), null);
});

test("unhealthy accounts are slowed down", () => {
  const l = accountLimits(
    { consecutiveFailures: 3 },
    { hourlyLimit: 60 },
    settings,
  );
  assert.equal(l.hourly, 30);
});

test("pacing interval and speed options", () => {
  assert.equal(intervalMs(60), 60_000);
  assert.equal(intervalMs(30), 120_000);
  assert.equal(intervalMs(0), Infinity);
  const opts = speedOptions(60).map((o) => o.perHour);
  assert.ok(opts.includes(30) && opts.includes(60) && !opts.includes(90));
});

test("SMTP failure classification", () => {
  assert.equal(
    classifySmtpError({ code: "EAUTH", responseCode: 535 }).kind,
    "AUTH",
  );
  assert.equal(
    classifySmtpError({
      responseCode: 451,
      response: "451 4.7.1 Rate limited, try again later",
    }).kind,
    "THROTTLED",
  );
  assert.equal(
    classifySmtpError({
      responseCode: 421,
      response: "421 Service not available",
    }).kind,
    "TRANSIENT",
  );
  assert.equal(
    classifySmtpError({ responseCode: 550, response: "550 5.1.1 User unknown" })
      .kind,
    "INVALID_RECIPIENT",
  );
  assert.equal(
    classifySmtpError({
      responseCode: 554,
      response: "554 5.7.1 Message rejected for policy reasons",
    }).kind,
    "PERMANENT",
  );
  assert.equal(
    classifySmtpError({
      responseCode: 550,
      response: "550 5.4.5 Daily user sending quota exceeded",
    }).kind,
    "THROTTLED",
  );
  assert.equal(
    classifySmtpError({
      code: "ECONNECTION",
      command: "CONN",
      dataPhase: false,
    }).kind,
    "TRANSIENT",
    "safe to retry before DATA",
  );
  assert.equal(
    classifySmtpError({ code: "ETIMEDOUT", command: "CONN", dataPhase: true })
      .kind,
    "UNCERTAIN",
    "never blind-retry after DATA",
  );
  assert.equal(
    classifySmtpError({ code: "ESOCKET", command: "CONN" }).kind,
    "UNCERTAIN",
    "unknown phase => uncertain",
  );
});

test("SMTP phase tracking against a real SMTP server", async () => {
  const nodemailer = (await import("nodemailer")).default;
  const { SMTPServer } = await import("smtp-server");
  const { smtpPhaseTracking } = await import("../src/services/smtpPhase.js");
  assert.equal(smtpPhaseTracking, true, "nodemailer patch applied");
  const srv = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onRcptTo(a, _s, cb) {
      if (a.address.startsWith("bad"))
        return cb(
          Object.assign(new Error("5.1.1 User unknown"), { responseCode: 550 }),
        );
      return cb();
    },
    onData(stream, s, cb) {
      stream.resume();
      stream.on("end", () => {
        if (!s.envelope.rcptTo[0].address.startsWith("drop")) cb();
      });
    },
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.server.address().port;
  const t = nodemailer.createTransport({
    host: "127.0.0.1",
    port,
    secure: false,
    ignoreTLS: true,
    pool: true,
    maxConnections: 1,
    socketTimeout: 1000,
  });
  const send = (to) =>
    t.sendMail({ from: "a@x.com", to, subject: "s", text: "x" }).then(
      () => null,
      (e) => e,
    );
  assert.equal(await send("ok@y.com"), null);
  const bad = await send("bad@y.com");
  assert.equal(classifySmtpError(bad).kind, "INVALID_RECIPIENT");
  assert.equal(
    await send("ok2@y.com"),
    null,
    "flag resets for the next envelope on a pooled connection",
  );
  const drop = await send("drop@y.com");
  assert.equal(drop.dataPhase, true);
  assert.equal(classifySmtpError(drop).kind, "UNCERTAIN");
  t.close();
  await new Promise((r) => srv.close(r));
  const down = await nodemailer
    .createTransport({
      host: "127.0.0.1",
      port,
      secure: false,
      ignoreTLS: true,
    })
    .sendMail({ from: "a@x.com", to: "z@y.com", text: "x" })
    .catch((e) => e);
  assert.equal(down.dataPhase, false);
  assert.equal(classifySmtpError(down).kind, "TRANSIENT");
});

test("templates escape values and strip unknown variables", () => {
  assert.equal(
    renderTemplate(
      "Hi {{firstName}}{{missing}}",
      { firstName: "<b>Ann</b>" },
      { html: true },
    ),
    "Hi &lt;b&gt;Ann&lt;/b&gt;",
  );
  assert.equal(
    renderTemplate("Subject {{x}}", { x: "a\r\nBcc: evil@x.com" }),
    "Subject a Bcc: evil@x.com",
    "no header injection via newlines",
  );
  const clean = sanitizeEmailHtml(
    '<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
  );
  assert.ok(!/script|onclick|javascript:/i.test(clean));
});

test("buildMessage always includes unsubscribe + threading headers", () => {
  const msg = buildMessage({
    campaign: {
      subject: "Hello {{firstName}}",
      html: '<p>Hi</p><a href="https://example.com">x</a>',
      text: "",
    },
    recipient: {
      email: "a@example.com",
      token: "tok_tok_tok_tok_tok_tok",
      vars: { firstName: "Ann" },
      inReplyTo: "<orig@x>",
      references: "<orig@x>",
    },
    account: { email: "me@sender.com", displayName: "Me" },
    owner: { name: "Owner" },
    settings,
    messageId: "<id@sender.com>",
  });
  assert.equal(msg.subject, "Hello Ann");
  assert.match(msg.headers["List-Unsubscribe"], /\/u\/tok_tok/);
  assert.equal(
    msg.headers["List-Unsubscribe-Post"],
    "List-Unsubscribe=One-Click",
  );
  assert.equal(msg.inReplyTo, "<orig@x>");
  assert.match(msg.html, /\/t\/c\/tok_tok/);
  assert.match(msg.html, /\/t\/o\/tok_tok/);
  assert.match(msg.text, /Unsubscribe: http/);
});

test("click links are signed", () => {
  const url = "https://example.com/a?b=1";
  const signed = new URL(clickUrl("tok123tok123tok123", url));
  assert.ok(
    verifyClick("tok123tok123tok123", url, signed.searchParams.get("s")),
  );
  assert.ok(
    !verifyClick(
      "tok123tok123tok123",
      "https://evil.com",
      signed.searchParams.get("s"),
    ),
  );
  assert.equal(hmac("x").length, 22);
});

test("TTL cache is bounded, expires and de-duplicates concurrent loads", async () => {
  const c = new TtlCache({ max: 2, ttlMs: 50 });
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.get("a"), undefined, "LRU eviction");
  let calls = 0;
  const load = () =>
    c.wrap("k", async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });
  const [x, y] = await Promise.all([load(), load()]);
  assert.equal(x + y, 84);
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.get("k"), undefined, "expired");
});

test("AWS SigV4 signer matches the AWS documentation test vector", async () => {
  const { signV4 } = await import("../src/services/transports.js");
  const { signature } = signV4({
    method: "GET",
    host: "iam.amazonaws.com",
    path: "/",
    query: "Action=ListUsers&Version=2010-05-08",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    payload: "",
    region: "us-east-1",
    service: "iam",
    amzDate: "20150830T123600Z",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  });
  assert.equal(
    signature,
    "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  );
});

test("HTTPS transport failures map onto the same retry/duplicate-safety rules", async () => {
  const { transportKind, sesRegion } =
    await import("../src/services/transports.js");
  assert.equal(transportKind({ authType: "OAUTH2" }), "GMAIL_API");
  assert.equal(transportKind({ authType: "SES_API" }), "SES_API");
  assert.equal(transportKind({ authType: "PASSWORD" }), "SMTP");
  assert.equal(
    sesRegion({ smtpHost: "email.ap-south-1.amazonaws.com" }),
    "ap-south-1",
  );
  // Simulated shapes produced by transports.js
  assert.equal(
    classifySmtpError({ code: "EAUTH", responseCode: 535, dataPhase: false })
      .kind,
    "AUTH",
  );
  assert.equal(
    classifySmtpError({
      responseCode: 451,
      response: "451 rate limited: TooManyRequests",
      dataPhase: false,
    }).kind,
    "THROTTLED",
  );
  assert.equal(
    classifySmtpError({
      code: "ECONNECTION",
      dataPhase: false,
      message: "Network error: ENOTFOUND",
    }).kind,
    "TRANSIENT",
  );
  assert.equal(
    classifySmtpError({
      code: "ETIMEDOUT",
      dataPhase: true,
      message: "Network error: TimeoutError",
    }).kind,
    "UNCERTAIN",
    "request may have reached the API",
  );
});

test("names and companies are guessed from email addresses, conservatively", async () => {
  const { guessFromEmail, splitFullName } =
    await import("../src/lib/nameGuess.js");
  assert.deepEqual(guessFromEmail("ravi.kumar@acme-tools.co.in"), {
    firstName: "Ravi",
    lastName: "Kumar",
    company: "Acme Tools",
  });
  assert.deepEqual(guessFromEmail("info@tcs.com"), {
    firstName: "",
    lastName: "",
    company: "TCS",
  });
  assert.deepEqual(guessFromEmail("priya123@gmail.com"), {
    firstName: "Priya",
    lastName: "",
    company: "",
  });
  assert.equal(guessFromEmail("jsmith@corp.com").firstName, ""); // not a recognisable first name
  assert.deepEqual(splitFullName("Kumar, Ravi"), {
    firstName: "Ravi",
    lastName: "Kumar",
  });
});

test("template fallback {{firstName|there}} and guessed variables", async () => {
  const { renderTemplate, buildVars } =
    await import("../src/services/template.js");
  assert.equal(
    renderTemplate("Hi {{firstName|there}},", { firstName: "" }),
    "Hi there,",
  );
  assert.equal(
    renderTemplate("Hi {{firstName|there}},", { firstName: "Anu" }),
    "Hi Anu,",
  );
  assert.equal(renderTemplate("{{x|<b>}}", {}, { html: true }), "&lt;b&gt;");
  const v = buildVars({
    recipient: {
      email: "meera.shah@nova-plastics.com",
      vars: { firstName: "", company: "" },
    },
    owner: { name: "P" },
  });
  assert.equal(v.firstName, "Meera");
  assert.equal(v.companyName, "Nova Plastics");
  const kept = buildVars({
    recipient: { email: "meera.shah@nova.com", vars: { firstName: "Mira" } },
    owner: {},
  });
  assert.equal(kept.firstName, "Mira");
  assert.equal(kept.lastName, ""); // don't mix a real first name with a guessed surname
});

test("variable names are matched loosely; sender name comes from the account", async () => {
  const { renderTemplate, buildVars, senderNameFor } =
    await import("../src/services/template.js");
  const v = buildVars({
    recipient: { email: "anu.shah@acme.in", vars: { City: "Pune" } },
    owner: { name: "Priya" },
    account: { email: "sales@acme.in", displayName: "Rahul from Acme" },
  });
  assert.equal(
    renderTemplate(
      "{{First Name}} {{last_name}} / {{name}} / {{company}} / {{city}} / {{sender}}",
      v,
    ),
    "Anu Shah / Anu Shah / Acme / Pune / Rahul from Acme",
  );
  assert.equal(senderNameFor({ email: "ravi.kumar@x.com" }), "Ravi Kumar");
  assert.equal(
    senderNameFor({ email: "abaccotech.crm@gmail.com" }),
    "abaccotech.crm@gmail.com",
  ); // weak guess → use the address
});

test("bounce notices are recognised (Gmail DSN with original Message-ID, and plain notices without one)", async () => {
  const { simpleParser } = await import("mailparser");
  const { detectBounce } = await import("../src/services/imap.js");
  const dsn = [
    "From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    "To: sender@acme.com",
    "Subject: Delivery Status Notification (Failure)",
    "Message-ID: <bounce-1@mx.google.com>",
    "X-Failed-Recipients: nobody@example.org",
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain",
    "",
    "Address not found. Your message wasn't delivered to nobody@example.org",
    "",
    "--b1",
    "Content-Type: message/delivery-status",
    "",
    "Final-Recipient: rfc822; nobody@example.org",
    "Action: failed",
    "Status: 5.1.1",
    "",
    "--b1",
    "Content-Type: message/rfc822",
    "",
    "Message-ID: <orig-123@acme.com>",
    "Subject: Hello",
    "",
    "Hi",
    "",
    "--b1--",
    "",
  ].join("\r\n");
  const p = await simpleParser(dsn);
  const b = detectBounce(p, "mailer-daemon@googlemail.com");
  assert.ok(b.hard);
  assert.ok(b.originalMessageIds.includes("<orig-123@acme.com>"));
  assert.equal(b.finalRecipient, "nobody@example.org");
  const plain = await simpleParser(
    "From: Mail Delivery System <MAILER-DAEMON@zoho.com>\r\nSubject: Undelivered Mail Returned to Sender\r\nX-Failed-Recipients: ghost@nowhere.in\r\n\r\nThe user does not exist.\r\n",
  );
  const b2 = detectBounce(plain, "mailer-daemon@zoho.com");
  assert.ok(b2.hard);
  assert.equal(b2.finalRecipient, "ghost@nowhere.in");
  assert.equal(
    detectBounce(
      await simpleParser(
        "From: Ravi <ravi@acme.com>\r\nSubject: Re: Hello\r\n\r\nThanks!",
      ),
      "ravi@acme.com",
    ),
    null,
    "a normal reply is not a bounce",
  );
});

test("out-of-office / auto-replies are recognised and are not counted as replies", async () => {
  const { isAutoReply } = await import("../src/services/imap.js");
  const msg = (subject, headers = {}) => ({
    subject,
    headers: new Map(Object.entries(headers)),
  });
  assert.equal(isAutoReply(msg("Automatic reply: Quick question")), true);
  assert.equal(isAutoReply(msg("Out of Office until Monday")), true);
  assert.equal(
    isAutoReply(
      msg("Re: Quick question", { "auto-submitted": "auto-replied" }),
    ),
    true,
  );
  assert.equal(
    isAutoReply(msg("Re: Quick question", { precedence: "auto_reply" })),
    true,
  );
  assert.equal(
    isAutoReply(msg("Re: Quick question", { "auto-submitted": "no" })),
    false,
  );
  assert.equal(
    isAutoReply(msg("Re: Quick question — yes, let us talk")),
    false,
  );
});

test("pitch score rewards short, personal pitches and flags spammy ones", async () => {
  const { scorePitch, scoreSubject } =
    await import("../../frontend/src/lib/pitchScore.js");
  const good = scorePitch({
    subjects: ["Quick question, {{firstName}}"],
    html: "<p>Hi {{firstName}},</p><p>I noticed {{companyName}} is hiring engineers. We help teams like yours cut onboarding time in half.</p><p>Would a 10-minute call next week be useful?</p><p>Regards,<br>{{senderName}}</p>",
  });
  const bad = scorePitch({
    subjects: ["FREE!!! ACT NOW 100% GUARANTEED"],
    html: '<p>DEAR SIR, WE ARE THE BEST COMPANY!!! Click here to buy now, risk free, limited time offer!!! <a href="https://a.example">1</a><a href="https://b.example">2</a><a href="https://c.example">3</a></p>',
  });
  assert.ok(good.score >= 75, `good pitch scored ${good.score}`);
  assert.ok(bad.score < 40, `spammy pitch scored ${bad.score}`);
  assert.ok(bad.tips.length > 0);
  assert.ok(
    scoreSubject("Quick question, {{firstName}}").score >
      scoreSubject("FREE MONEY!!!").score,
  );
});

test("campaign finish estimate follows speed, daily caps and the employee total", async () => {
  const { simulate } = await import("../src/services/eta.js");
  const settings = {
    defaultHourlyLimit: 60,
    defaultDailyLimit: 5000,
    maxEmployeeDailyLimit: 10000,
    defaultAccountLimit: 100,
    maxAccountLimit: 1000,
  };
  const owner = { hourlyLimit: null, dailyLimit: null, accountLimit: null };
  const acct = (extra = {}) => ({
    maxHourly: null,
    maxDaily: null,
    warmupEnabled: false,
    consecutiveFailures: 0,
    ...extra,
  });
  const start = new Date("2026-11-25T00:00:00Z"); // start of a UTC day and hour

  // 2 mailboxes x 100 emails at 10/hour each -> 10 hours.
  let r = simulate({
    start,
    owner,
    settings,
    mailboxes: [
      { account: acct(), pending: 100, rate: 10, share: 1 },
      { account: acct(), pending: 100, rate: 10, share: 1 },
    ],
  });
  assert.equal(r.hours, 10);
  assert.equal(r.limitedBy, "speed");

  // A mailbox shared with one other campaign runs at half speed -> 20 hours.
  r = simulate({
    start,
    owner,
    settings,
    mailboxes: [{ account: acct(), pending: 100, rate: 10, share: 2 }],
  });
  assert.equal(r.hours, 20);

  // Account daily cap 50 at 60/hour: 120 emails -> day 1: 50, day 2: 50, day 3: 20 (finishes on the third day).
  r = simulate({
    start,
    owner,
    settings,
    mailboxes: [
      { account: acct({ maxDaily: 50 }), pending: 120, rate: 60, share: 1 },
    ],
  });
  assert.ok(
    r.finishAt >= new Date("2026-11-27T00:00:00Z") &&
      r.finishAt < new Date("2026-11-27T02:00:00Z"),
    String(r.finishAt),
  );
  assert.equal(r.limitedBy, "daily");

  // Employee total 100/day across 3 mailboxes, 300 emails -> 3 days even though each mailbox could do more.
  const capped = { ...owner, dailyLimit: 100 };
  r = simulate({
    start,
    owner: capped,
    settings,
    mailboxes: [0, 1, 2].map(() => ({
      account: acct(),
      pending: 100,
      rate: 60,
      share: 1,
    })),
  });
  assert.ok(r.finishAt >= new Date("2026-11-27T00:00:00Z"), String(r.finishAt));
  assert.equal(r.limitedBy, "employee");
});
