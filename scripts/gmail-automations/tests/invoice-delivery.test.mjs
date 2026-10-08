import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureInvoiceStatement, ensureInvoiceDraft, invoiceMessageId } from '../lib/invoice-delivery.mjs';
import { sheetsApplyPlan, sheetsGetValues, buildMessageMime } from '../lib/google.mjs';

const invoice = { invoice: 274, po: '70062955', totalPence: 191040 };
const initialGrid = () => [
  ['Invoice No', 'Invoice Date', 'PO No', 'Invoice Amount', 'Payment Due', 'Status'],
  ['Subtotal — Overdue'], ['Subtotal — Due Soon'], ['Subtotal — Not Yet Due'], ['TOTAL OUTSTANDING'],
];
function harness() {
  const state = new Map();
  let grid = initialGrid();
  let writes = 0;
  let failStep;
  const database = async (action, body) => {
    if (action === 'checkpoint-get') return { execution: state.get(body.step) ?? null };
    if (body.step === failStep) { failStep = null; throw new Error('checkpoint outage'); }
    state.set(body.step, { status: 'completed', result: structuredClone(body.result) });
    return { ok: true };
  };
  const options = {
    database, inv: invoice, today: '2026-10-08', readGrid: async () => structuredClone(grid), validatePdf: () => {},
    writePlan: async (plan) => {
      writes++;
      const values = plan.updates.filter((u) => /^A\d+:F\d+$/.test(u.range)).map((u) => u.values[0]);
      grid.splice(plan.insertAt, 0, ...values);
    },
  };
  return { state, options, get grid() { return grid; }, get writes() { return writes; }, fail: (step) => { failStep = step; } };
}

test('recovers a committed statement row after the checkpoint fails, retaining invoice date', async () => {
  const h = harness();
  h.fail('statement-row');
  await assert.rejects(ensureInvoiceStatement(h.options), /checkpoint outage/);
  assert.equal(h.writes, 1);
  const recovered = await ensureInvoiceStatement({ ...h.options, today: '2026-10-09' });
  assert.equal(recovered.invoiceDate, '2026-10-08');
  assert.equal(h.writes, 1);
  assert.equal(h.state.get('statement-row').status, 'completed');
});

test('does not write a row unless the invoice intent was saved first', async () => {
  const h = harness();
  h.fail('prepared');
  await assert.rejects(ensureInvoiceStatement(h.options), /checkpoint outage/);
  assert.equal(h.writes, 0);
});

test('rejects PDF validation failure before persisting invoice or statement', async () => {
  const h = harness();
  await assert.rejects(ensureInvoiceStatement({ ...h.options, validatePdf: () => { throw new Error('oversize'); } }), /oversize/);
  assert.equal(h.writes, 0);
  assert.equal(h.state.size, 0);
});

test('manual statement rows are skipped and mismatching recovered rows are blocked', async () => {
  const h = harness();
  h.grid.splice(3, 0, [274, '08-10-2026', 70062955, 1910.40, '22-11-2026', 'UPCOMING']);
  assert.equal(await ensureInvoiceStatement(h.options), null);
  assert.equal(h.writes, 0);
  h.state.delete('draft-created');
  h.state.set('prepared', { status: 'completed', result: { invoice: { ...invoice, invoiceDate: '2026-10-08' } } });
  h.grid[3][3] = 999;
  await assert.rejects(ensureInvoiceStatement(h.options), /differs|differ/);
});

test('statement timeouts after commit are recovered without reinsertion', async () => {
  const h = harness();
  await assert.rejects(ensureInvoiceStatement({ ...h.options, writePlan: async (plan) => {
    await h.options.writePlan(plan); throw new Error('Sheets timeout');
  } }), /Sheets timeout/);
  await ensureInvoiceStatement(h.options);
  assert.equal(h.writes, 1);
});

test('a created draft is recovered after its final checkpoint fails', async () => {
  const h = harness();
  let messages = [];
  let creations = 0;
  const options = { database: h.options.database, inv: invoice, findMessage: async (id) => {
    assert.equal(id, invoiceMessageId(274)); return messages;
  }, createInvoiceDraft: async () => {
    creations++; messages = [{ id: 'message-1', labelIds: ['DRAFT'] }]; return { id: 'draft-1' };
  } };
  h.fail('draft-created');
  await assert.rejects(ensureInvoiceDraft(options), /checkpoint outage/);
  assert.deepEqual(await ensureInvoiceDraft(options), { recovered: true });
  assert.equal(creations, 1);
});

test('recovers a sent invoice and never creates a second draft', async () => {
  const h = harness();
  await ensureInvoiceDraft({ database: h.options.database, inv: invoice,
    findMessage: async () => [{ id: 'sent-1', labelIds: ['SENT'] }],
    createInvoiceDraft: () => assert.fail('must not duplicate sent email') });
  assert.equal(h.state.get('draft-created').result.sent, true);
});

test('ambiguous Gmail creation is never blindly retried', async () => {
  const h = harness();
  let calls = 0;
  const options = { database: h.options.database, inv: invoice, findMessage: async () => [],
    createInvoiceDraft: async () => { calls++; throw new Error('Gmail timeout'); } };
  await assert.rejects(ensureInvoiceDraft(options), /Gmail timeout/);
  await assert.rejects(ensureInvoiceDraft(options), /check Drafts, Sent and Bin/);
  assert.equal(calls, 1);
});

test('multiple matching emails and deleted drafts need manual reconciliation', async () => {
  const h = harness();
  const options = { database: h.options.database, inv: invoice, createInvoiceDraft: () => assert.fail('must not duplicate') };
  await assert.rejects(ensureInvoiceDraft({ ...options, findMessage: async () => [{ id: 'a' }, { id: 'b' }] }), /multiple/);
  await assert.rejects(ensureInvoiceDraft({ ...options, findMessage: async () => [{ id: 'a', labelIds: ['TRASH', 'DRAFT'] }] }), /deleted/);
});

test('dry-run does not save a Gmail attempt checkpoint', async () => {
  const h = harness();
  let calls = 0;
  await ensureInvoiceDraft({ database: h.options.database, inv: invoice, dryRun: true,
    findMessage: async () => [], createInvoiceDraft: async () => { calls++; return { id: 'preview' }; } });
  assert.equal(calls, 1);
  assert.equal(h.state.size, 0);
});

test('Sheets inserts and writes are one batch, with literal text and formulas typed explicitly', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  });
  await sheetsApplyPlan('token', 'sheet', 10, { insertAt: 7, count: 1, updates: [
    { range: 'A8:F8', values: [[274, '08-10-2026', '70062955', 1910.4]], raw: true },
    { range: 'D9', values: [['=SUM(D8:D8)']] },
  ] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /:batchUpdate$/);
  assert.equal(calls[0].body.requests.length, 3);
  assert.equal(calls[0].body.requests[0].insertDimension.range.startIndex, 7);
  assert.deepEqual(calls[0].body.requests[1].updateCells.rows[0].values[1].userEnteredValue, { stringValue: '08-10-2026' });
  assert.deepEqual(calls[0].body.requests[2].updateCells.rows[0].values[0].userEnteredValue, { formulaValue: '=SUM(D8:D8)' });
});

test('Sheets reads evaluated values, including formula-based due dates', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
    return { ok: true, status: 200, json: async () => ({ values: [[274]] }) };
  });
  assert.deepEqual(await sheetsGetValues('token', 'sheet', "'PLT Statement'!A:I"), [[274]]);
});

test('draft MIME carries its stable recovery identifier', () => {
  const mime = buildMessageMime({ to: ['buyer@example.com'], subject: 'Invoice', body: 'Attached', messageId: invoiceMessageId(274) });
  assert.match(mime, /Message-ID: <denovo-plt-invoice-274@denovosourcing\.com>\r\n/);
});
