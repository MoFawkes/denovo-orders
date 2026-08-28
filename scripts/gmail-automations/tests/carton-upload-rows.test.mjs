import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCartonUploadRows as automationBuilder,
  CartonUploadValidationError,
} from '../lib/domain.mjs';
import {
  buildCartonUploadRows as websiteBuilder,
  buildSkuAndExpectedBySize,
  fullSkuFromProductCode,
  serializeCartonUploadCsv,
} from '../../../web/carton-upload-rows.mjs';

const cartons = [
  { size: '8', colour: 'TAUPE', quantity: 20, cartonType: 'BDCM1' },
  { size: '8', colour: 'TAUPE', quantity: 10, cartonType: 'bdcm3' },
  { size: '10', colour: 'TAUPE', quantity: 18, cartonType: 'BDCM1', cartonNote: 'A3' },
];
const mapping = {
  8: { sku: '001/CNR0463/70', expectedQuantity: 30 },
  10: { sku: 'CNR0463/40/58', expectedQuantity: 18 },
};

test('builds the exact Portal columns and one deterministic row per carton', () => {
  const result = websiteBuilder({ cartons, skuAndExpectedBySize: mapping });
  assert.deepEqual(result.headers, ['sku', 'size', 'colour', 'expectedQuantity', 'cartonSize', 'quantity', 'cartonId', 'cartonNote']);
  assert.equal(result.rows.length, cartons.length);
  assert.deepEqual(result.rows.map(({ cartonId }) => cartonId), [1, 2, 3]);
  assert.equal(result.rows[0].sku, '001/CNR0463/70');
  assert.equal(result.rows[0].expectedQuantity, 30);
  assert.equal(result.rows[1].expectedQuantity, '');
  assert.equal(result.rows[2].cartonNote, 'A3');
});

test('website and automation imports use the same row builder', () => {
  assert.deepEqual(automationBuilder({ cartons, skuAndExpectedBySize: mapping }), websiteBuilder({ cartons, skuAndExpectedBySize: mapping }));
});

test('buyer product codes remain full and preserve leading zeros', () => {
  assert.equal(fullSkuFromProductCode(' 001/CNR0463/145 '), '001/CNR0463/145');
  assert.equal(fullSkuFromProductCode('HZZ40922-425-20'), 'HZZ40922-425-20');
});

test('builds the size mapping from the real buyer CSV column shape and selected PO', () => {
  const rows = [
    { productCode: 'CNR0463/40/145', productName: 'Taupe Petite Dress - UK 2, US 00', supplierRef: 'CNR0463', PONumber: '0070056980', supplierName: 'Denovo', orderQty: '100', productGroup: 'Dress', EAN: '0500000000001' },
    { productCode: 'CNR0463/40/72', productName: 'Taupe Petite Dress-4', supplierRef: 'CNR0463', PONumber: '0070056980', supplierName: 'Denovo', orderQty: '80', productGroup: 'Dress', EAN: '0500000000002' },
    { productCode: 'OTHER/1', productName: 'Other Dress-2', supplierRef: 'OTHER', PONumber: '0070000000', supplierName: 'Denovo', orderQty: '5', productGroup: 'Dress', EAN: '0500000000003' },
  ];
  assert.deepEqual(buildSkuAndExpectedBySize(rows, '70056980'), {
    2: { sku: 'CNR0463/40/145', expectedQuantity: 100 },
    4: { sku: 'CNR0463/40/72', expectedQuantity: 80 },
  });
});

test('rejects buyer references missing authoritative columns', () => {
  assert.throws(
    () => buildSkuAndExpectedBySize([{ productCode: 'A', productName: 'Dress-8', orderQty: '1' }], '1'),
    /PONumber/,
  );
});

test('CSV serializer preserves exact headers, row count, and text identifiers', () => {
  const csv = serializeCartonUploadCsv({ cartons, skuAndExpectedBySize: mapping });
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'sku,size,colour,expectedQuantity,cartonSize,quantity,cartonId,cartonNote');
  assert.equal(lines.length, cartons.length + 1);
  assert.match(lines[1], /^001\/CNR0463\/70,/);
  assert.equal(csv.includes('pageSetup'), false);
});

for (const [name, input, code] of [
  ['zero cartons', { cartons: [] }, 'NO_CARTONS'],
  ['mixed-SKU cartons', { cartons: [{ ...cartons[0], skus: ['A', 'B'] }], skuAndExpectedBySize: mapping }, 'MIXED_SKU_CARTON'],
  ['missing carton type', { cartons: [{ ...cartons[0], cartonType: '' }], skuAndExpectedBySize: mapping }, 'INVALID_CARTON_SIZE'],
  ['invalid carton type', { cartons: [{ ...cartons[0], cartonType: 'nonStdXS' }], skuAndExpectedBySize: mapping }, 'INVALID_CARTON_SIZE'],
  ['unresolved SKU', { cartons: [cartons[0]], skuAndExpectedBySize: {} }, 'UNRESOLVED_SKU'],
  ['conflicting expected quantities', { cartons: [{ ...cartons[0], sku: 'A', expectedQuantity: 10 }, { ...cartons[1], sku: 'A', expectedQuantity: 12 }] }, 'CONFLICTING_EXPECTED_QUANTITY'],
  ['invalid quantity', { cartons: [{ ...cartons[0], quantity: 1.5 }], skuAndExpectedBySize: mapping }, 'INVALID_QUANTITY'],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => websiteBuilder(input), (err) => err instanceof CartonUploadValidationError && err.errors.some(({ code: actual }) => actual === code));
  });
}
