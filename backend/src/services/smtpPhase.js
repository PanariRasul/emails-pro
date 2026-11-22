// Duplicate-send protection.
// Nodemailer tags every socket-level error with command "CONN" regardless of the SMTP phase,
// so the error alone can't tell "never reached the server" from "server may already have the message".
// We record on each SMTP connection whether the DATA (or BDAT) command has been issued for the current
// envelope, and stamp that onto errors as `err.dataPhase`:
//   dataPhase === false  -> failed before DATA: safe to retry
//   dataPhase === true   -> failed during/after DATA: outcome UNKNOWN, never blind-retry
//   dataPhase undefined  -> we could not tell: treated as UNKNOWN (safe default)
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { logger } from '../lib/logger.js';

const proto = SMTPConnection?.prototype;
export let smtpPhaseTracking = false;

if (proto && typeof proto._sendCommand === 'function' && typeof proto._formatError === 'function' && !proto.__epPatched) {
  const origSend = proto._sendCommand;
  const origFormat = proto._formatError;
  proto._sendCommand = function patchedSendCommand(str, ...rest) {
    if (typeof str === 'string') {
      if (str.startsWith('MAIL FROM') || str === 'RSET') this.__epDataSent = false;
      else if (str === 'DATA' || str.startsWith('BDAT')) this.__epDataSent = true;
    }
    return origSend.call(this, str, ...rest);
  };
  proto._formatError = function patchedFormatError(...args) {
    const err = origFormat.apply(this, args);
    if (err && typeof err === 'object') err.dataPhase = Boolean(this.__epDataSent);
    return err;
  };
  proto.__epPatched = true;
  smtpPhaseTracking = true;
} else if (!proto?.__epPatched) {
  logger.warn('SMTP phase tracking unavailable for this nodemailer version; all network send errors will be treated as UNKNOWN');
}
