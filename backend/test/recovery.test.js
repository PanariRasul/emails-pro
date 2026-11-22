// DB-level guarantees: concurrent quota reservation and crash recovery.
// Runs only with E2E_DATABASE_URL pointing at a DISPOSABLE database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const DB = process.env.E2E_DATABASE_URL;
const skip = !DB && 'E2E_DATABASE_URL not set';
if (DB) {
  process.env.DATABASE_URL = DB;
  process.env.ENCRYPTION_KEY ||= Buffer.alloc(32, 9).toString('base64');
  process.env.JWT_SECRET ||= 'recovery-test-secret-recovery-test-1234';
  process.env.LOG_LEVEL = 'error';
}

const mods = DB ? {
  ...(await import('../src/lib/prisma.js')),
  ...(await import('../src/worker/quota.js')),
  ...(await import('../src/worker/maintenance.js')),
  ...(await import('../src/lib/crypto.js')),
} : {};

after(async () => { if (DB) await mods.closeDb(); });

async function fixture() {
  const { prisma, randomToken } = mods;
  const tag = randomToken(6).toLowerCase();
  const user = await prisma.user.create({ data: { email: `rt-${tag}@example.com`, name: 'RT', passwordHash: 'x' } });
  const account = await prisma.emailAccount.create({
    data: { ownerId: user.id, email: `rt-${tag}@sender.com`, provider: 'CUSTOM', smtpHost: 'localhost', smtpPort: 25, smtpUser: 'u', smtpPassEnc: 'x', status: 'CONNECTED' },
  });
  const campaign = await prisma.campaign.create({ data: { ownerId: user.id, name: 'RT', accountId: account.id, subject: 's', html: 'h', text: 't', status: 'SENDING' } });
  return { user, account, campaign, tag };
}

test('two campaigns sharing one account can never exceed its hourly limit (concurrent workers)', { skip }, async () => {
  const { prisma, reserveSend, QuotaError } = mods;
  const { user, account } = await fixture();
  const limits = { hourly: 5, daily: 100, employeeDaily: 100 };
  let ok = 0; let slot = 0; let hour = 0;
  for (let round = 0; round < 4; round += 1) {
    // Simulate many workers racing for the same account at the same instant.
    await prisma.emailAccount.update({ where: { id: account.id }, data: { nextSendAt: null } });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => reserveSend({ accountId: account.id, ownerId: user.id, limits })));
    for (const r of results) {
      if (r.status === 'fulfilled') ok += 1;
      else if (r.reason instanceof QuotaError && r.reason.kind === 'SLOT') slot += 1;
      else if (r.reason instanceof QuotaError && r.reason.kind === 'HOUR') hour += 1;
      else throw r.reason;
    }
  }
  assert.equal(ok, 4, 'exactly one reservation per pacing slot');
  assert.ok(slot >= 20, 'concurrent racers lose the slot');
  for (let i = 0; i < 3; i += 1) {
    await prisma.emailAccount.update({ where: { id: account.id }, data: { nextSendAt: null } });
    await reserveSend({ accountId: account.id, ownerId: user.id, limits }).then(() => { ok += 1; }, (e) => { if (e.kind === 'HOUR') hour += 1; else throw e; });
  }
  assert.equal(ok, 5, 'hourly cap of 5 is never exceeded');
  assert.ok(hour >= 2);
});

test('crash recovery: STARTED attempt => UNKNOWN (no resend); no attempt => PENDING; ACCEPTED => SENT', { skip }, async () => {
  const { prisma, recoverStuck, randomToken } = mods;
  const { campaign, account } = await fixture();
  const old = new Date(Date.now() - 60 * 60_000);
  const mk = (email) => prisma.campaignRecipient.create({
    data: { campaignId: campaign.id, accountId: account.id, email, token: randomToken(18), status: 'SENDING', attempts: 1, lockedAt: old, lockedBy: 'dead-instance' },
  });
  const [a, b, c] = await Promise.all([mk('a@x.com'), mk('b@x.com'), mk('c@x.com')]);
  await prisma.sendAttempt.create({ data: { recipientId: a.id, campaignId: campaign.id, accountId: account.id, attemptNo: 1, idempotencyKey: `${a.id}:1`, messageId: '<a@x>', status: 'STARTED' } });
  await prisma.sendAttempt.create({ data: { recipientId: c.id, campaignId: campaign.id, accountId: account.id, attemptNo: 1, idempotencyKey: `${c.id}:1`, messageId: '<c@x>', status: 'ACCEPTED', finishedAt: old } });

  await recoverStuck({ onStartup: true });
  const after1 = Object.fromEntries((await prisma.campaignRecipient.findMany({ where: { campaignId: campaign.id } })).map((r) => [r.email, r]));
  assert.equal(after1['a@x.com'].status, 'UNKNOWN');
  assert.equal(after1['b@x.com'].status, 'PENDING');
  assert.equal(after1['b@x.com'].attempts, 0);
  assert.equal(after1['c@x.com'].status, 'SENT');
  void b;
});

test('scheduler starts due campaigns exactly once even with concurrent schedulers', { skip }, async () => {
  const { prisma, schedulerTick } = mods;
  const { campaign } = await fixture();
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'SCHEDULED', scheduledAt: new Date(Date.now() - 1000) } });
  const results = await Promise.all([schedulerTick(), schedulerTick(), schedulerTick()]);
  const started = results.reduce((s, r) => s + r.started, 0);
  assert.equal(started, 1, 'conditional update => exactly one scheduler wins');
  const c = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  assert.equal(c.status, 'SENDING');
});
