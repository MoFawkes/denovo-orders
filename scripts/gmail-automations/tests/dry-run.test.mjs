import test from 'node:test';
import assert from 'node:assert/strict';

test('Google write adapters return synthetic results without calling fetch in dry-run mode', async () => {
  process.env.DRY_RUN = '1';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network write attempted'); };
  try {
    const google = await import(`../lib/google.mjs?dry-run=${Date.now()}`);
    await google.modifyThreadLabels('token', 'thread-1', { add: ['label-1'] });
    const reply = await google.sendReply('token', {
      threadId: 'thread-1', replyTo: { payload: { headers: [] } },
      to: 'person@example.com', subject: 'Test', body: 'Hello',
    });
    const task = await google.createTask('token', { title: 'Test', notes: 'PO', dueDate: '2026-07-10' });
    await google.patchTask('token', 'task-1', { status: 'completed' });
    const file = await google.driveUploadFile('token', {
      name: 'test.xlsx', mimeType: 'application/test', buffer: Buffer.from('test'),
    });
    assert.equal(reply.id, 'dry-run-message');
    assert.equal(task.id, 'dry-run-task');
    assert.equal(file.id, 'dry-run-drive-file');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.DRY_RUN;
  }
});

test('checkpoint writes do not touch Supabase in dry-run mode', async () => {
  process.env.DRY_RUN = '1';
  try {
    const state = await import(`../lib/execution-state.mjs?dry-run=${Date.now()}`);
    const database = { from() { throw new Error('database write attempted'); } };
    await state.completeExecution(database, 'automation', 'source', 'step');
    await state.failExecution(database, 'automation', 'source', 'step', new Error('expected'));
  } finally {
    delete process.env.DRY_RUN;
  }
});
