import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortalManifest, validatePortalManifest } from '../lib/portal-manifest.mjs';

const input = {
  po: '70056980', gmailThreadId: 'thread-1', invoiceId: '220', workbookBytes: Buffer.from('workbook'),
  sourceRevision: 'abc123', executionId: '77f31472-ef76-45a8-9768-abb3f2ab6676',
  groups: [{ sku: 'CNR0463/40', cartons: [
    { size: '4', qty: 20, carton_type: 'BDCM1' },
    { size: '6', qty: 15, small: true },
  ] }],
};

test('builds a stable, validated manual-entry handoff', () => {
  const first = buildPortalManifest(input);
  const second = buildPortalManifest(input);
  assert.equal(first.po, '0070056980');
  assert.equal(first.expectedCartonCount, 2);
  assert.deepEqual(first.cartons.map((carton) => carton.cartonSize), ['BDCM1', 'BDCM3']);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.match(first.workbookSha256, /^[0-9a-f]{64}$/);
});

test('blocks duplicate carton ids and unsupported carton types', () => {
  const manifest = buildPortalManifest(input);
  manifest.cartons[1].cartonId = 1;
  assert.throws(() => validatePortalManifest(manifest), /unique positive/);
  manifest.cartons[1].cartonId = 2;
  manifest.cartons[1].cartonSize = 'NONSTDXL';
  assert.throws(() => validatePortalManifest(manifest), /BDCM1 or BDCM3/);
});
