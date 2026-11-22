import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { isTransientDbError } from '../lib/prisma.js';

/** Validate req.body / req.query / req.params with Zod; replaces them with parsed values. */
export const validate = (schemas) => (req, _res, next) => {
  try {
    for (const part of ['body', 'query', 'params']) {
      if (!schemas[part]) continue;
      const r = schemas[part].safeParse(req[part] ?? {});
      if (!r.success) {
        throw badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      }
      req[part] = r.data; // Express 4: req.query is assignable
    }
    next();
  } catch (err) {
    next(err);
  }
};

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const idParam = z.object({ id: z.string().min(1).max(40) });

/** Abort slow requests so a stuck DB call can't hold the event loop / connection forever. */
export function requestTimeout(req, res, next) {
  res.setTimeout(config.requestTimeoutMs, () => {
    if (!res.headersSent) {
      res.status(503).json({ error: { code: 'TIMEOUT', message: 'The server took too long to respond. Please retry.', retryable: true } });
    }
  });
  next();
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Invalid JSON body' } });
  }
  if (isTransientDbError(err)) {
    logger.warn({ err: err.message, path: req.path }, 'database unavailable');
    res.setHeader('Retry-After', '5');
    return res.status(503).json({ error: { code: 'DB_UNAVAILABLE', message: 'Database is waking up. Please retry in a few seconds.', retryable: true } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with these details already exists' } });
    if (err.code === 'P2025') return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
  }
  logger.error({ err: { message: err?.message, stack: err?.stack }, path: req.path, userId: req.user?.id }, 'unhandled error');
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
