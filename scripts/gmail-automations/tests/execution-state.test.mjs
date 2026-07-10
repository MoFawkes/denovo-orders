import test from 'node:test';
import assert from 'node:assert/strict';
import { getExecution, completeExecution, failExecution } from '../lib/execution-state.mjs';

function fakeSupabase(initial = null) {
  const writes = [];
  const filters = {};
  const query = {
    select() { return this; },
    eq(column, value) { filters[column] = value; return this; },
    async maybeSingle() { return { data: initial, error: null }; },
    async upsert(value) { writes.push(value); return { error: null }; },
  };
  return {
    writes,
    filters,
    from(table) {
      assert.equal(table, 'automation_executions');
      return query;
    },
  };
}

test('getExecution reads a checkpoint by its composite identity', async () => {
  const db = fakeSupabase({ status: 'completed', result: { id: 'drive-1' } });
  const row = await getExecution(db, 'draft-packing-list', 'thread-1', 'drive-upload:224');
  assert.equal(row.result.id, 'drive-1');
  assert.deepEqual(db.filters, {
    automation: 'draft-packing-list',
    source_id: 'thread-1',
    step: 'drive-upload:224',
  });
});

test('completeExecution increments attempts and clears a previous error', async () => {
  const db = fakeSupabase({ attempt_count: 2, result: {}, last_error: 'old failure' });
  await completeExecution(db, 'draft-packing-list', 'thread-1', 'drive-upload:224', { id: 'drive-1' });
  assert.equal(db.writes[0].status, 'completed');
  assert.equal(db.writes[0].attempt_count, 3);
  assert.equal(db.writes[0].last_error, null);
  assert.deepEqual(db.writes[0].result, { id: 'drive-1' });
  assert.ok(db.writes[0].completed_at);
});

test('failExecution preserves a successful result for recovery and records the error', async () => {
  const db = fakeSupabase({ attempt_count: 1, result: { id: 'drive-1' } });
  await failExecution(db, 'draft-packing-list', 'thread-1', 'confirmation', new Error('Gmail unavailable'));
  assert.equal(db.writes[0].status, 'failed');
  assert.equal(db.writes[0].attempt_count, 2);
  assert.equal(db.writes[0].last_error, 'Gmail unavailable');
  assert.deepEqual(db.writes[0].result, { id: 'drive-1' });
  assert.equal(db.writes[0].completed_at, null);
});

test('state errors are surfaced instead of silently disabling idempotency', async () => {
  const db = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: null, error: { message: 'permission denied' } }; },
      };
    },
  };
  await assert.rejects(
    getExecution(db, 'a', 'b', 'c'),
    /reading automation checkpoint failed: permission denied/,
  );
});
