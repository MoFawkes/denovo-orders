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
      attachments: [{ filename: 'test.xlsx', mimeType: 'application/test', buffer: Buffer.from('test') }],
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

test('buildReplyMime creates a wrapped multipart attachment', async () => {
  const { buildReplyMime } = await import(`../lib/google.mjs?mime=${Date.now()}`);
  const mime = buildReplyMime({
    to: 'person@example.com', subject: 'Test', messageId: '<message@example.com>',
    references: '<earlier@example.com> <message@example.com>', body: 'Hello',
    attachments: [{ filename: 'stickers.xlsx', mimeType: 'application/test', buffer: Buffer.alloc(200, 1) }],
  });
  assert.match(mime, /Content-Type: multipart\/mixed; boundary="(denovo-\d+)"/);
  const boundary = mime.match(/boundary="([^"]+)"/)[1];
  assert.equal(mime.split(`--${boundary}`).length - 1, 3);
  assert.match(mime, /Content-Disposition: attachment; filename="stickers\.xlsx"/);
  const encoded = mime.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split(`\r\n--${boundary}--`)[0];
  assert.ok(encoded.split('\r\n').every((line) => line.length <= 76));
});

test('buildReplyMime preserves the original plain-text message bytes without attachments', async () => {
  const { buildReplyMime } = await import(`../lib/google.mjs?plain=${Date.now()}`);
  assert.equal(
    buildReplyMime({
      to: 'person@example.com', subject: 'Test', messageId: '<message@example.com>',
      references: '<message@example.com>', body: 'Hello',
    }),
    'To: person@example.com\r\nSubject: Re: Test\r\nIn-Reply-To: <message@example.com>\r\n' +
      'References: <message@example.com>\r\nContent-Type: text/plain; charset=UTF-8\r\n' +
      'MIME-Version: 1.0\r\n\r\nHello',
  );
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
