import test from 'node:test';
import assert from 'node:assert/strict';
import { claimPortalSubmission, transitionPortalSubmission } from '../lib/portal-state.mjs';

test('recognises an atomic claim owned by this runner', async () => {
  const database = async () => ({ submission: { state: 'claimed', claimed_by: 'run-1' } });
  const result = await claimPortalSubmission(database, { idempotencyKey: 'key' }, 'run-1');
  assert.equal(result.claimed, true);
  assert.equal(result.noOp, false);
});

test('post-submit states are immutable no-ops to the runner', async () => {
  const database = async () => ({ submission: { state: 'uncertain-after-submit', claimed_by: 'old-run' } });
  const result = await claimPortalSubmission(database, { idempotencyKey: 'key' }, 'run-2');
  assert.equal(result.claimed, false);
  assert.equal(result.noOp, true);
});

test('transitions carry expected state and idempotency identity', async () => {
  const calls = [];
  const database = async (action, payload) => { calls.push({ action, payload }); return { submission: { state: payload.nextState } }; };
  await transitionPortalSubmission(database, { idempotencyKey: 'key' }, 'claimed', 'failed-before-submit', {}, new Error('bad selector'));
  assert.deepEqual(calls[0], { action: 'portal-submission-transition', payload: {
    idempotencyKey: 'key', expectedState: 'claimed', nextState: 'failed-before-submit', result: {}, error: 'bad selector',
  } });
});
