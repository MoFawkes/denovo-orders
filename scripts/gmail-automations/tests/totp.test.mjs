import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBase32, generateTotp } from '../lib/totp.mjs';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('decodes Base32 secrets without logging or external dependencies', () => {
  assert.equal(decodeBase32(RFC_SECRET).toString(), '12345678901234567890');
});

test('matches all RFC 6238 HMAC-SHA1 test vectors', () => {
  for (const [seconds, expected] of RFC_VECTORS) {
    assert.equal(generateTotp(RFC_SECRET, { timestamp: seconds * 1000, digits: 8 }), expected);
  }
});

test('rejects malformed secrets', () => {
  assert.throws(() => generateTotp('not-valid!'), /valid Base32/);
});
