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

test('packing-list DB wrapper retries transient gateway errors on reads', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 520, text: async () => '<html>520</html>' };
    if (calls === 2) throw new Error('fetch failed');
    return { ok: true, json: async () => ({ execution: { status: 'completed' } }) };
  };
  try {
    const { callPackingListDb } = await import(`../lib/automation-db.mjs?retry=${Date.now()}`);
    const result = await callPackingListDb('checkpoint-get', {}, { retryDelaysMs: [0, 0, 0] });
    assert.equal(calls, 3);
    assert.equal(result.execution.status, 'completed');
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('packing-list DB wrapper gives up after the retries and shortens gateway pages', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 520, text: async () => `<html>\n${'x'.repeat(5000)}</html>` };
  };
  try {
    const { callPackingListDb } = await import(`../lib/automation-db.mjs?exhaust=${Date.now()}`);
    await assert.rejects(callPackingListDb('checkpoint-get', {}, { retryDelaysMs: [0, 0] }), (error) => {
      assert.match(error.message, /packing-list-db checkpoint-get failed: HTTP 520/);
      assert.ok(error.message.length < 500);
      return true;
    });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('packing-list DB wrapper never retries writes or non-transient errors', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 520, text: async () => 'gateway' };
  };
  try {
    const { callPackingListDb } = await import(`../lib/automation-db.mjs?writes=${Date.now()}`);
    await assert.rejects(callPackingListDb('invoice-allocate', {}, { retryDelaysMs: [0, 0] }), /HTTP 520/);
    assert.equal(calls, 1);
    globalThis.fetch = async () => { calls++; return { ok: false, status: 401, text: async () => 'unauthorized' }; };
    await assert.rejects(callPackingListDb('checkpoint-get', {}, { retryDelaysMs: [0, 0] }), /HTTP 401/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
