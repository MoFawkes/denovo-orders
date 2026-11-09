// Regression tests for the productName size/colour parsing in
// generate-docket.mjs. The PLT export changed the size suffix from
// `...Colour-2` to `...Colour - UK 2` mid-July 2026, which parsed no sizes and
// left every docket save with an empty `rows` array (HTTP 400). These pin both
// the new and legacy suffix forms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSizeFromName, extractColourFromName, normalizeStyleNo, lookupCosting, cleanFabric, extractFabricByProductCode } from '../generate-docket.mjs';

test('unsupplied PO fabric stays blank instead of defaulting to Bengaline', () => {
  for (const value of ['N/A', 'n / a', 'NA', '-', '', null]) assert.equal(cleanFabric(value), '');
  assert.equal(cleanFabric(' Cotton '), 'Cotton');
  const fabrics = extractFabricByProductCode('Fabric Weight Fabrication ABC123 N/A DEF456 Cotton Deliver To:', ['ABC123', 'DEF456']);
  assert.equal(cleanFabric(fabrics.ABC123), '');
  assert.equal(cleanFabric(fabrics.DEF456), 'Cotton');
});

test('supplier style references accept a dash without changing unrelated SKUs', () => {
  for (const ref of ['D-5760', 'D5760', ' d - 5760 ']) {
    assert.equal(normalizeStyleNo(ref), 'D5760');
  }
  assert.equal(normalizeStyleNo('CNJ-5760'), null);
  assert.equal(normalizeStyleNo('D-5760-A'), null);
});

test('dashed supplier reference resolves a costing stored under the plain SKU', async () => {
  const calls = [];
  const costing = { style_no: 'D5760', cmt: 3.5 };
  const result = await lookupCosting(async (action, args) => {
    calls.push({ action, ...args });
    return { costing: args.sku === 'D5760' ? costing : null };
  }, 'D-5760', normalizeStyleNo('D-5760'));
  assert.equal(result, costing);
  assert.deepEqual(calls.map(call => call.sku), ['D-5760', 'D5760']);
});

test('an exact supplier reference match takes precedence', async () => {
  let calls = 0;
  const costing = { style_no: 'D5760', cmt: 4 };
  assert.equal(await lookupCosting(async () => {
    calls++;
    return { costing };
  }, 'D-5760', 'D5760'), costing);
  assert.equal(calls, 1);
});

test('extractSizeFromName reads the new " - UK <n>" suffix', () => {
  assert.equal(extractSizeFromName('Petite Black Scoop Neck Sleeveless Maxi Dress Black - UK 2'), '2');
  assert.equal(extractSizeFromName('Some Dress Lemon - UK 16'), '16');
});

test('extractSizeFromName reads UK size when a US size follows it', () => {
  const name = 'Stretch Woven Boat Neck Long Sleeve Pleated Shift Dress Burgundy - UK 4, US 0';
  assert.equal(extractSizeFromName(name), '4');
  assert.equal(extractColourFromName(name), 'Burgundy');
});

test('extractSizeFromName still reads the legacy "-<n>" suffix', () => {
  assert.equal(extractSizeFromName('Petite Black Scoop Neck Sleeveless Maxi Dress Black-2'), '2');
});

test('extractSizeFromName returns null when there is no size suffix', () => {
  assert.equal(extractSizeFromName('Petite Black Scoop Neck Sleeveless Maxi Dress'), null);
});

test('extractColourFromName reads the colour past the new " - UK <n>" suffix', () => {
  assert.equal(extractColourFromName('Petite Black Scoop Neck Sleeveless Maxi Dress Black - UK 2'), 'Black');
});

test('extractColourFromName still reads the colour past the legacy "-<n>" suffix', () => {
  assert.equal(extractColourFromName('Petite Black Scoop Neck Sleeveless Maxi Dress Black-2'), 'Black');
});
