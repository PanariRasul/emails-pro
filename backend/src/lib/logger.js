import pino from 'pino';
import { config } from '../config/index.js';

// Structured JSON logs. Credentials and tokens are redacted defensively.
export const logger = pino({
  level: config.logLevel,
  base: { app: 'emails-pro', instance: config.instanceId },
  redact: {
    paths: [
      'password', '*.password', 'smtpPass', '*.smtpPass', 'imapPass', '*.imapPass',
      'smtpPassEnc', '*.smtpPassEnc', 'imapPassEnc', '*.imapPassEnc',
      'token', '*.token', 'accessToken', 'refreshToken', 'req.headers.authorization', 'req.headers.cookie',
      'auth.pass', '*.auth.pass',
    ],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
