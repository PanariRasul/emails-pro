// Email one-time codes for login (OTP) and password reset.
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/errors.js';
import { codeEmail, sendSystemMail } from './systemMail.js';

export const OTP_TTL_MIN = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 45;
export const OTP_MAX_SENDS = 5;

const hashCode = (challengeId, code) => crypto.createHmac('sha256', config.jwtSecret).update(`${challengeId}:${code}`).digest('hex');

export function maskEmail(email) {
  const [u, d] = String(email).split('@');
  const shown = u.length <= 2 ? u[0] : `${u.slice(0, 2)}${'•'.repeat(Math.min(6, u.length - 2))}`;
  return `${shown}@${d}`;
}

function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

async function deliverCode(user, purpose, challengeId, code) {
  const mail = codeEmail({ purpose, code, name: user.name, minutes: OTP_TTL_MIN });
  try {
    await sendSystemMail({ to: user.email, ...mail });
  } catch (err) {
    if (err.code === 'MAIL_NOT_CONFIGURED') {
      throw new HttpError(503, 'MAIL_NOT_CONFIGURED', 'Email codes are unavailable because the system mailbox is not configured. Contact your administrator.');
    }
    throw new HttpError(503, 'MAIL_SEND_FAILED', 'We could not send the email code right now. Please try again in a minute.');
  }
  return challengeId;
}

/** Create a challenge (invalidating older open ones of the same purpose) and email the code. */
export async function startChallenge(user, purpose, { remember = false, ip } = {}) {
  await prisma.authChallenge.updateMany({ where: { userId: user.id, purpose, consumedAt: null }, data: { consumedAt: new Date() } });
  const code = newCode();
  const ch = await prisma.authChallenge.create({
    data: { userId: user.id, purpose, codeHash: 'pending', remember, ip, expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60_000) },
  });
  await prisma.authChallenge.update({ where: { id: ch.id }, data: { codeHash: hashCode(ch.id, code) } });
  await deliverCode(user, purpose, ch.id, code);
  return ch;
}

export async function resendChallenge(challengeId, purpose) {
  const ch = await prisma.authChallenge.findUnique({ where: { id: challengeId }, include: { user: true } });
  if (!ch || ch.purpose !== purpose || ch.consumedAt || ch.expiresAt < new Date()) {
    throw new HttpError(400, 'CODE_EXPIRED', 'This code has expired. Please start again.');
  }
  const wait = OTP_RESEND_SECONDS - Math.floor((Date.now() - ch.lastSentAt.getTime()) / 1000);
  if (wait > 0) throw new HttpError(429, 'RESEND_TOO_SOON', `Please wait ${wait}s before requesting another code.`, { retryAfter: wait });
  if (ch.sendCount >= OTP_MAX_SENDS) throw new HttpError(429, 'TOO_MANY_CODES', 'Too many codes requested. Please start again later.');
  const code = newCode();
  await prisma.authChallenge.update({
    where: { id: ch.id },
    data: { codeHash: hashCode(ch.id, code), attempts: 0, lastSentAt: new Date(), sendCount: { increment: 1 }, expiresAt: new Date(Date.now() + OTP_TTL_MIN * 60_000) },
  });
  await deliverCode(ch.user, purpose, ch.id, code);
  return ch;
}

/** Verify a code. Atomic attempt counting; a challenge can be consumed exactly once. */
export async function verifyChallenge(challengeId, code, purpose) {
  const ch = await prisma.authChallenge.findUnique({ where: { id: challengeId }, include: { user: true } });
  const bad = (msg = 'Incorrect or expired code') => new HttpError(400, 'INVALID_CODE', msg);
  if (!ch || ch.purpose !== purpose || ch.consumedAt) throw bad('This code is no longer valid. Please start again.');
  if (ch.expiresAt < new Date()) throw bad('This code has expired. Request a new one.');
  if (ch.attempts >= OTP_MAX_ATTEMPTS) throw bad('Too many incorrect attempts. Request a new code.');
  const inc = await prisma.authChallenge.updateMany({
    where: { id: ch.id, consumedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (!inc.count) throw bad('Too many incorrect attempts. Request a new code.');
  const expected = Buffer.from(ch.codeHash);
  const given = Buffer.from(hashCode(ch.id, String(code).replace(/\D/g, '')));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    const left = OTP_MAX_ATTEMPTS - ch.attempts - 1;
    throw bad(left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many incorrect attempts. Request a new code.');
  }
  const consumed = await prisma.authChallenge.updateMany({ where: { id: ch.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (!consumed.count) throw bad('This code was already used.');
  return ch;
}
