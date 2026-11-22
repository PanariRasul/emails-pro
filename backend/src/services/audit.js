import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/** Fire-and-forget audit record. Never throws into the request path. */
export function audit(req, action, entityType, entityId, meta) {
  const actorId = req?.user?.id ?? null;
  prisma.auditLog.create({
    data: { actorId, action, entityType, entityId, meta: meta ?? undefined, ip: req?.ip ?? null },
  }).catch((err) => logger.warn({ err: err.message, action }, 'audit write failed'));
}

export async function notify({ userId = null, forAdmins = false, type, title, body }) {
  try {
    await prisma.notification.create({ data: { userId, forAdmins, type, title, body } });
  } catch (err) {
    logger.warn({ err: err.message, type }, 'notification write failed');
  }
}
