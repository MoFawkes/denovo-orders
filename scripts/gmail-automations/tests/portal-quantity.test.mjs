import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPortalQuantities, extractPurchaseOrderLines, extractLabelStatus } from '../lib/portal-quantity.mjs';

const lines = [
  { sku: 'CNK5852/197/72', size: '4', quantity: 30 },
  { sku: 'CNK5852/197/68', size: '6', quantity: 80 },
  { sku: 'CNK5852/197/61', size: '16', quantity: 10 },
];
const carton = (size, quantity) => ({ baseSku: 'CNK5852', size, quantity });

test('exact quantities pass without warnings', () => {
  const result = checkPortalQuantities(lines, [carton('4', 30), carton('6', 40), carton('6', 40), carton('16', 10)]);
  assert.deepEqual(result, { warnings: [], errors: [] });
});

test('up to 5 over, or any amount under, warns but does not stop', () => {
  const result = checkPortalQuantities(lines, [carton('4', 31), carton('6', 70), carton('16', 15)]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings[0], /size 4: packed 31 is 1 over the ordered 30/);
  assert.match(result.warnings[1], /size 6: packed 70 is 10 under the ordered 80/);
  assert.match(result.warnings[2], /size 16: packed 15 is 5 over the ordered 10/);
});

test('more than 5 over stops; a large shortfall only warns', () => {
  const result = checkPortalQuantities(lines, [carton('4', 36), carton('6', 20), carton('16', 10)]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /6 over the ordered 30 \(limit 5\)/);
  assert.match(result.warnings.join('\n'), /size 6: packed 20 is 60 under the ordered 80/);
});

test('unpacked lines and unknown sizes are judged too', () => {
  const result = checkPortalQuantities(lines, [carton('4', 30), carton('8', 5)]);
  assert.match(result.errors.join('\n'), /size 8: not on the Portal purchase order/);
  assert.equal(result.errors.length, 1);
  assert.match(result.warnings.join('\n'), /CNK5852\/197\/68 size 6: nothing packed against the ordered 80/);
  assert.match(result.warnings.join('\n'), /size 16: nothing packed against the ordered 10/);
});

test('refuses to judge without Portal lines and finds them in a tRPC batch', () => {
  assert.throws(() => checkPortalQuantities(null, [carton('4', 30)]), /lines are unavailable/);
  assert.equal(extractPurchaseOrderLines([{ result: { data: { json: { shipmentId: 1 } } } }]), null);
  assert.deepEqual(extractPurchaseOrderLines([{ result: { data: { json: { purchaseOrderLines: lines } } } }, {}]), lines);
});

test('reads the shipment label status from a tRPC batch', () => {
  const po = { result: { data: { json: { purchaseOrderLines: lines } } } };
  assert.equal(extractLabelStatus([po, { result: { data: { json: { shipmentId: 68833, labelStatus: 'submitted' } } } }]), 'submitted');
  assert.equal(extractLabelStatus([po, { result: { data: { json: { shipmentId: 1, labelStatus: 'inProgress' } } } }]), 'inProgress');
  assert.equal(extractLabelStatus([po, { result: { data: { json: null } } }]), null);
  assert.equal(extractLabelStatus(null), null);
});
