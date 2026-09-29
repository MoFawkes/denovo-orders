const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../web/index.html'), 'utf8');
const source = html.slice(html.indexOf('let sampleApprovalPreview = []'), html.indexOf('function pickColourCol(row)'));
function setup(extra = {}) {
  const context = vm.createContext(extra);
  vm.runInContext(source, context);
  return context;
}
const headers = 'PO,Style,Sage Sample Approved';
const order = (id, po, style, sample_approved = false, stage = 'Pending') => ({ id, po, style, sample_approved, stage });

test('CSV handles BOM, quoted commas, escaped quotes and multiline comments', () => {
  const ctx = setup();
  const rows = ctx.parseSampleApprovalCSV('\uFEFF' + headers + ',Comments\r\n700,CNP0933,Yes,"Sent, with ""label""\r\nconfirmed"\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].approval, 'yes');
  for (const text of ['', headers, headers + '\n1,A', headers + '\n1,A,"Yes', 'PO,Style,Style,Sage Sample Approved\n1,A,A,Yes']) {
    assert.throws(() => ctx.parseSampleApprovalCSV(text));
  }
});

test('matches PO plus buyer style, approves colour rows, preserves No conflicts and terminal orders', () => {
  const ctx = setup();
  const rows = ctx.parseSampleApprovalCSV(headers + '\n70069756,CNP0933,Yes\n70071990,CNP0933,No\n3,END,Yes\n4,WRONG,Yes\n5,MISSING,Yes');
  const preview = ctx.buildSampleApprovalPreview(rows, [order(1,'70069756','CNP0933'), order(2,'70069756','CNP0933'), order(3,'70071990','CNP0933',true), order(4,'3','END',false,'Completed'), order(5,'3','END',false,'Cancelled'), order(6,'4','OTHER'), order(7,'999','ABSENT')]);
  assert.deepEqual(Array.from(preview[0].targets, o => o.id), [1,2]);
  assert.match(preview[1].status, /existing approval kept/);
  assert.equal(preview.slice(1).flatMap(r => r.targets).length, 0);
});

test('duplicate, missing and invalid input cannot approve orders', () => {
  const ctx = setup();
  const rows = ctx.parseSampleApprovalCSV(headers + '\n1,A,Yes\n1,A,No\n2,B,Maybe\n,C,Yes');
  assert.equal(ctx.buildSampleApprovalPreview(rows, [order(1,'1','A'),order(2,'2','B')]).flatMap(r => r.targets).length, 0);
});

test('application sends approval-only updates with race guards and reports partial failures', async () => {
  const elements = new Map();
  const writes = [];
  const ctx = setup({ canEditOrders: true, document: { getElementById(id) { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } }, loadOrders: async () => {}, sb: { from(table) {
    const calls = { table, filters: [] }; writes.push(calls);
    return { update(payload) { calls.payload = payload; return this; }, eq(...args) { calls.filters.push(args); return this; }, not(...args) { calls.not = args; return this; }, or(filter) { calls.or = filter; return this; }, async select() { return writes.length === 1 ? {data:[{id:1}]} : writes.length === 2 ? {data:[]} : {error:{message:'Permission denied'}}; } };
  } } });
  ctx.targets = [order(1,'1','A'),order(2,'2','B'),order(3,'3','C')];
  vm.runInContext('sampleApprovalPreview = [{ targets }]',ctx);
  await ctx.applySampleApprovals();
  assert.equal(writes.length,3);
  for (const write of writes) {
    assert.equal(JSON.stringify(write.payload), '{"sample_approved":true}');
    assert.deepEqual(Array.from(write.not), ['stage','in','(Completed,Cancelled)']);
    assert.equal(write.or,'sample_approved.eq.false,sample_approved.is.null');
    assert.deepEqual(Array.from(write.filters, pair => pair[0]), ['id','po','style']);
  }
  assert.match(elements.get('sample-import-message').textContent,/1 approval\(s\) saved.*1 unchanged.*1 failed/);
  assert.equal(elements.get('sample-import-apply').disabled,true);
  await ctx.applySampleApprovals();
  assert.equal(writes.length,3);
  ctx.canEditOrders = false;
  vm.runInContext('sampleApprovalPreview = [{ targets }]',ctx);
  await ctx.applySampleApprovals();
  assert.equal(writes.length,3);
});
