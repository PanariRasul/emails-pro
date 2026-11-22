import crypto from 'node:crypto';
import { config } from '../config/index.js';

// AES-256-GCM for SMTP/IMAP secrets. Format: v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>
// keyId lets us rotate ENCRYPTION_KEY while still decrypting values written with the previous key.

function keyIdOf(keyB64) {
  return crypto.createHash('sha256').update(keyB64).digest('hex').slice(0, 8);
}

function keyring() {
  const ring = new Map();
  ring.set(keyIdOf(config.encryptionKey), Buffer.from(config.encryptionKey, 'base64'));
  if (config.encryptionKeyPrevious) {
    ring.set(keyIdOf(config.encryptionKeyPrevious), Buffer.from(config.encryptionKeyPrevious, 'base64'));
  }
  return ring;
}

export function encryptSecret(plain) {
  if (plain == null || plain === '') return null;
  const key = Buffer.from(config.encryptionKey, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', keyIdOf(config.encryptionKey), iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload) {
  if (!payload) return null;
  const [v, kid, ivB64, tagB64, dataB64] = payload.split(':');
  if (v !== 'v1') throw new Error('Unsupported secret format');
  const key = keyring().get(kid);
  if (!key) throw new Error('Encryption key for this secret is not available');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function needsReEncryption(payload) {
  if (!payload) return false;
  return payload.split(':')[1] !== keyIdOf(config.encryptionKey);
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hmac(value, secret = config.trackingSecret) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('base64url').slice(0, 22);
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
