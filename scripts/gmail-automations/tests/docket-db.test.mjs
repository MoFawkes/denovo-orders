import test from 'node:test';
import assert from 'node:assert/strict';

test('docket DB wrapper uses its dedicated secret and action', async () => {
  process.env.DOCKET_DB_SECRET = 'docket-secret';
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ exists: false }) };
  };
  try {
    const { callDocketDb } = await import(`../lib/docket-db.mjs?test=${Date.now()}`);
    await callDocketDb('po-exists', { po: '0070053828' });
    assert.match(request.url, /\/functions\/v1\/docket-db$/);
    assert.equal(request.options.headers['x-automation-secret'], 'docket-secret');
    assert.deepEqual(JSON.parse(request.options.body), { action: 'po-exists', po: '0070053828' });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.DOCKET_DB_SECRET;
  }
});
