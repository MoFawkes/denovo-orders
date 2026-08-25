import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { stampPortalPackingList } from '../lib/portal-packing-list.mjs';

async function portalTemplate() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('body');
  sheet.mergeCells('F3:J3');
  sheet.mergeCells('K3:N3');
  sheet.mergeCells('F4:J4');
  sheet.mergeCells('K4:N4');
  sheet.getCell('F3').value = 'INVOICE SERIAL NUMBER :';
  sheet.getCell('F4').value = 'INVOICE DATE :';
  sheet.getCell('K3').protection = { locked: false };
  sheet.getCell('K4').protection = { locked: false };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('adds the invoice number and dispatch date to the Portal packing list', async () => {
  const result = await stampPortalPackingList(await portalTemplate(), {
    invoiceId: 'INV-224',
    dispatchDate: '2026-07-11',
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result);
  const sheet = workbook.getWorksheet('body');
  assert.equal(sheet.getCell('K3').value, 'INV-224');
  assert.equal(sheet.getCell('K4').value, '11/07/2026');
  assert.equal(sheet.getCell('K3').protection.locked, false);
  assert.equal(sheet.getCell('K4').protection.locked, false);
});

test('refuses a workbook whose Invoice Details fields are missing', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('body');
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(
    stampPortalPackingList(bytes, { invoiceId: '224', dispatchDate: '2026-07-11' }),
    /no Invoice Details fields/,
  );
});
