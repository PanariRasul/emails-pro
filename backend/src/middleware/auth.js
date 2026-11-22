import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { caches } from '../lib/cache.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, tv: user.tokenVersion }, config.jwtSecret, {
    expiresIn: config.accessTokenTtlSec,
    issuer: 'emails-pro',
    audience: 'emails-pro-api',
  });
}

export async function loadUser(id) {
  return caches.users.wrap(`user:${id}`, () => prisma.user.findUnique({
    where: { id },
    select: {
      id: true, email: true, name: true, role: true, isActive: true, sendingDisabled: true,
      accountLimit: true, dailyLimit: true, hourlyLimit: true, requireApproval: true, tokenVersion: true,
    },
  }));
}

export function invalidateUser(id) {
  caches.users.del(`user:${id}`);
}

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { issuer: 'emails-pro', audience: 'emails-pro-api' });
    } catch {
      throw unauthorized('Session expired');
    }
    const user = await loadUser(payload.sub);
    if (!user || !user.isActive || user.tokenVersion !== payload.tv) throw unauthorized('Session is no longer valid');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
  return next();
};

export const adminOnly = [requireAuth, requireRole('ADMIN')];
export const employeeOnly = [requireAuth, requireRole('EMPLOYEE')];
