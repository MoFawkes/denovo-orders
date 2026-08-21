import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function decodeBase32(value) {
  const input = String(value ?? '').toUpperCase().replace(/[\s=-]/g, '');
  if (!input || /[^A-Z2-7]/.test(input)) throw new Error('TOTP secret must be valid Base32');
  let bits = '';
  for (const character of input) bits += BASE32.indexOf(character).toString(2).padStart(5, '0');
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(secret, options = {}) {
  const timestamp = options.timestamp ?? Date.now();
  const stepSeconds = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;
  const algorithm = options.algorithm ?? 'sha1';
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('timestamp must be non-negative');
  if (!Number.isInteger(stepSeconds) || stepSeconds <= 0) throw new Error('stepSeconds must be positive');
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new Error('digits must be between 6 and 10');
  const counter = BigInt(Math.floor(timestamp / 1000 / stepSeconds));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac(algorithm, decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(binary % (10 ** digits)).padStart(digits, '0');
}
