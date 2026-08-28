import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBuyerCsv,
  cartonsFromGroups,
  buildPortalCsvFromBuyerReference,
} from '../lib/buyer-reference.mjs';

const buyerCsv = [
  'productCode,productName,PONumber,orderQty',
  '001/CNR0463/70,"Dress, Sage - UK 8",0070065988,30',
  'CNR0463/40/58,Dress Sage - UK 10,0070065988,18',
].join('\r\n');

const groups = [{
  colour: 'SAGE',
  sku: 'CNR0463',
  cartons: [
    { size: '8', qty: 20, small: false },
    { size: '8', qty: 10, small: true },
    { size: '10', qty: 18, carton_type: 'BDCM1' },
  ],
}];

test('parses quoted buyer CSV rows without losing commas or leading zeros', () => {
  const rows = parseBuyerCsv(buyerCsv);
  assert.equal(rows[0].productCode, '001/CNR0463/70');
  assert.equal(rows[0].productName, 'Dress, Sage - UK 8');
  assert.equal(rows[0].PONumber, '0070065988');
});

test('converts docket groups into Portal carton inputs', () => {
  assert.deepEqual(cartonsFromGroups(groups), [
    { size: '8', colour: 'SAGE', quantity: 20, cartonType: 'BDCM1' },
    { size: '8', colour: 'SAGE', quantity: 10, cartonType: 'BDCM3' },
    { size: '10', colour: 'SAGE', quantity: 18, cartonType: 'BDCM1' },
  ]);
});

test('generates the eight-column Portal upload CSV from the retained buyer reference', () => {
  const csv = buildPortalCsvFromBuyerReference({ csvText: buyerCsv, po: '0070065988', groups });
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'sku,size,colour,expectedQuantity,cartonSize,quantity,cartonId,cartonNote');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], '001/CNR0463/70,8,SAGE,30,bdcm1,20,1,');
  assert.equal(lines[2], '001/CNR0463/70,8,SAGE,,bdcm3,10,2,');
  assert.equal(lines[3], 'CNR0463/40/58,10,SAGE,18,bdcm1,18,3,');
});

test('rejects a retained CSV for the wrong PO', () => {
  assert.throws(
    () => buildPortalCsvFromBuyerReference({ csvText: buyerCsv, po: '0070000000', groups }),
    /contains no rows for PO/,
  );
});
