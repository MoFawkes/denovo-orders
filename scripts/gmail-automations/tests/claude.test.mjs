import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../lib/claude.mjs';

test('retries once when Anthropic returns an empty text response', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(calls === 1
      ? { content: [], stop_reason: 'end_turn' }
      : { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await extractJson({ apiKey: 'test', system: 'test', prompt: 'test' });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reports stop reason and content types after two non-JSON responses', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    content: [{ type: 'text', text: '' }],
    stop_reason: 'end_turn',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(
      extractJson({ apiKey: 'test', system: 'test', prompt: 'test' }),
      /after 2 attempts.*stop_reason=end_turn.*content_types=text/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
