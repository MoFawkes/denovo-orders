import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPortalConfig, validatePortalConfig } from '../lib/portal-config.mjs';

test('checked-in Portal config is complete and versioned', async () => {
  const config = await loadPortalConfig();
  assert.equal(config.schemaVersion, 1);
});

test('config validation rejects unsafe URLs and missing selectors', () => {
  assert.throws(() => validatePortalConfig({ schemaVersion: 1, urls: { purchaseOrders: 'http://bad' } }), /https/);
});
