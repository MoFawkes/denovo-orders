import test from 'node:test';
import assert from 'node:assert/strict';

test('packing-list DB wrapper sends the scoped secret and action payload', async () => {
  process.env.PACKING_LIST_DB_SECRET = 'scoped-secret';
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ orders: [] }) };
  };
  try {
    const { callPackingListDb } = await import(`../lib/automation-db.mjs?test=${Date.now()}`);
    await callPackingListDb('orders-for-po', { po: '0070053828' });
    assert.match(request.url, /\/functions\/v1\/packing-list-db$/);
    assert.equal(request.options.headers['x-automation-secret'], 'scoped-secret');
    assert.deepEqual(JSON.parse(request.options.body), { action: 'orders-for-po', po: '0070053828' });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PACKING_LIST_DB_SECRET;
  }
});

test('packing-list DB wrapper includes the action in HTTP errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  try {
    const { callPackingListDb } = await import(`../lib/automation-db.mjs?error=${Date.now()}`);
    await assert.rejects(callPackingListDb('snapshot'), /packing-list-db snapshot failed: HTTP 401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
