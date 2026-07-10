import test from 'node:test';
import assert from 'node:assert/strict';
import { getExecution, completeExecution, failExecution } from '../lib/execution-state.mjs';

function fakeDatabase(execution = null) {
  const calls = [];
  const database = async (action, payload) => {
    calls.push({ action, payload });
    return action === 'checkpoint-get' ? { execution } : { ok: true };
  };
  database.calls = calls;
  return database;
}

test('getExecution asks the scoped wrapper for the composite checkpoint identity', async () => {
  const database = fakeDatabase({ status: 'completed', result: { id: 'drive-1' } });
  const row = await getExecution(database, 'draft-packing-list', 'thread-1', 'drive-upload:224');
  assert.equal(row.result.id, 'drive-1');
  assert.deepEqual(database.calls[0], {
    action: 'checkpoint-get',
    payload: { automation: 'draft-packing-list', sourceId: 'thread-1', step: 'drive-upload:224' },
  });
});

test('completeExecution sends only the result and identity to the scoped wrapper', async () => {
  const database = fakeDatabase();
  await completeExecution(database, 'draft-packing-list', 'thread-1', 'drive-upload:224', { id: 'drive-1' });
  assert.deepEqual(database.calls[0], {
    action: 'checkpoint-complete',
    payload: {
      automation: 'draft-packing-list', sourceId: 'thread-1', step: 'drive-upload:224',
      result: { id: 'drive-1' },
    },
  });
});

test('failExecution sends a serialised error to the scoped wrapper', async () => {
  const database = fakeDatabase();
  await failExecution(database, 'draft-packing-list', 'thread-1', 'confirmation', new Error('Gmail unavailable'));
  assert.deepEqual(database.calls[0], {
    action: 'checkpoint-fail',
    payload: {
      automation: 'draft-packing-list', sourceId: 'thread-1', step: 'confirmation',
      error: 'Gmail unavailable',
    },
  });
});

test('wrapper errors are surfaced instead of silently disabling idempotency', async () => {
  const database = async () => { throw new Error('permission denied'); };
  await assert.rejects(getExecution(database, 'a', 'b', 'c'), /permission denied/);
});
