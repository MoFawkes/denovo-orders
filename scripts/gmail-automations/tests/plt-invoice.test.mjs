import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import {
  parseInvoiceTask,
  deliveryHasPassed,
  londonInstant,
  londonToday,
  productType,
  buildInvoicePdf,
  invoiceFilename,
  statementInvoiceNumbers,
  planStatementUpdate,
  draftSubject,
  helveticaWidth,
  packingInvoiceLines,
  planStatementAgeing,
  remittanceFriday,
  fridayOfWeek,
  buildStatementCsv,
} from '../lib/plt-invoice.mjs';
import { buildMessageMime } from '../lib/google.mjs';

test('statement CSV preserves sections, quotes and balances with UK dates and excludes paid history', () => {
  const csv = buildStatementCsv([
    ['DENOVO SOURCING'],
    ['Invoice No', 'Date', 'PO', 'Amount', 'Due', 'Status'],
    [279, 46303, '0070012345', 123.45, 46348, 'UPCOMING'],
    [278, 46303, '0070012344', 0, 46348, 'PAID'],
    ['CHARGE "fine", 1', '2026-10-08', '0070012345', 109.2, 'Immediate', 'OVERDUE / DISPUTED'],
    ['Subtotal — Overdue', '', '', 109.2],
    [],
  ]).toString('utf8');
  assert.ok(csv.includes('279,08/10/2026,0070012345,123.45,22/11/2026,UPCOMING'));
  assert.ok(!csv.includes('278,'));
  assert.ok(csv.includes('"CHARGE ""fine"", 1",08/10/2026,0070012345,109.2,Immediate,OVERDUE / DISPUTED'));
  assert.ok(csv.includes('Subtotal — Overdue,,,109.2'));
  assert.ok(csv.endsWith('\r\n'));
});

// The real booking task behind Invoice_0269_PO_70062955.pdf.
const TASK_269 = {
  id: 'task-269',
  status: 'completed',
  title: 'INV 269 — Black Stretch Woven Frill Hem Shift Dress',
  notes: '70062955\nCNO6432\nSun 27-Sep-26 11:00\nPrice (PPU): £8.00\nPacked qty (total): 199\nTotal boxes: 7\nEBUK22709-113',
};

function pdfContent(buffer) {
  const text = buffer.toString('latin1');
  const start = text.indexOf('stream\n', text.indexOf('/FlateDecode')) + 'stream\n'.length;
  const end = text.indexOf('\nendstream', start);
  return inflateSync(buffer.subarray(start, end)).toString('latin1');
}

test('parses a completed booking task into invoice data', () => {
  const inv = parseInvoiceTask(TASK_269);
  assert.equal(inv.problem, undefined);
  assert.equal(inv.invoice, 269);
  assert.equal(inv.po, '70062955');
  assert.equal(inv.sku, 'CNO6432');
  assert.equal(inv.description, 'Black Stretch Woven Frill Hem Shift Dress');
  assert.equal(inv.deliveryDate, '2026-09-27');
  assert.equal(inv.deliveryTime, '11:00');
  assert.equal(inv.bookingRef, 'EBUK22709-113');
  assert.equal(inv.quantity, 199);
  assert.equal(inv.cartons, 7);
  assert.equal(inv.unitPricePence, 800);
  assert.equal(inv.netPence, 159200);
  assert.equal(inv.vatPence, 31840);
  assert.equal(inv.totalPence, 191040); // £1,910.40 on the statement
});

test('ignores tasks without an INV title and flags ones it cannot price', () => {
  assert.equal(parseInvoiceTask({ title: 'Black Dress', notes: '70062955' }), null);
  const twoPrices = parseInvoiceTask({ ...TASK_269, notes: TASK_269.notes.replace('£8.00', '£8.00 / £9.50') });
  assert.match(twoPrices.problem, /more than one PPU/);
  const noBooking = parseInvoiceTask({ ...TASK_269, notes: '70062955\nCNO6432\nPrice (PPU): £8.00\nPacked qty (total): 199\nTotal boxes: 7' });
  assert.match(noBooking.problem, /no delivery date/);
  assert.equal(noBooking.bookingRef, null);
});

test('waits until the booked delivery time has passed in UK time', () => {
  const inv = parseInvoiceTask(TASK_269);
  // 27 Sep 2026 is BST (UTC+1): 11:00 London = 10:00 UTC.
  assert.equal(londonInstant('2026-09-27', '11:00').toISOString(), '2026-09-27T10:00:00.000Z');
  assert.equal(londonInstant('2026-12-01', '09:30').toISOString(), '2026-12-01T09:30:00.000Z');
  assert.equal(deliveryHasPassed(inv, new Date('2026-09-27T09:59:00Z')), false);
  assert.equal(deliveryHasPassed(inv, new Date('2026-09-27T10:00:00Z')), true);
  assert.equal(londonToday(new Date('2026-09-28T23:30:00Z')), '2026-09-29');
});

test('product column is the garment type from the description', () => {
  assert.equal(productType('Black Stretch Woven Frill Hem Shift Dress'), 'Dress');
  assert.equal(productType('Cream Shirt Dress'), 'Dress');
  assert.equal(productType('Black Tailored Wide Leg Jumpsuit'), 'Jumpsuit');
  assert.equal(productType('Something Else'), 'Garment');
});

test('invoice PDF reproduces the Invoice_0269 template text and positions', () => {
  const inv = parseInvoiceTask(TASK_269);
  const pdf = buildInvoicePdf(inv, { invoiceDate: '2026-09-25', createdAt: new Date('2026-09-25T15:31:45Z') });
  assert.equal(invoiceFilename(inv), 'Invoice_0269_PO_70062955.pdf');
  assert.match(pdf.toString('latin1'), /^%PDF-1\.4/);
  assert.match(pdf.toString('latin1'), /\/Title \(Invoice 0269 - PO 70062955\)/);
  assert.match(pdf.toString('latin1'), /\/CreationDate \(D:20260925163145\+01'00'\)/);
  const content = pdfContent(pdf);
  // [font, size, x, y, text] exactly as in the template's content stream.
  const expected = [
    ['F2', 22, 42, 793, 'Denovo Sourcing LTD'],
    ['F1', 9.5, 42, 772, '61-63 Bardolph Street,'],
    ['F1', 9.5, 42, 740.5, 'LE4 6EH'],
    ['F1', 8.5, 59, 703, 'To:'],
    ['F1', 10, 59, 692, 'Prettylittlething.com Limited'],
    ['F1', 10, 59, 648, 'M40 7FS'],
    ['F3', 22, 357, 692, 'Invoice'],
    ['F1', 10, 357, 660, '0269'],
    ['F1', 10, 357, 628, '25 September 2026'],
    ['F1', 8.5, 357, 607, 'Your reference/order number:'],
    ['F1', 10, 357, 596, '70062955'],
    ['F1', 10, 59, 552, '615 Shepcote Lane'],
    ['F1', 10, 59, 519, 'S9 1RF'],
    ['F1', 10, 42, 482, '7 Cartons sent via Jacks'],
    ['F1', 9.5, 472.359, 454.5, 'Price'],
    ['F1', 9.5, 544.718, 454.5, '\\243'],
    ['F1', 9.5, 45, 430, 'Dress'],
    ['F1', 9.5, 119, 430, '199'],
    ['F1', 9.5, 160, 430, 'CNO6432 Black Stretch Woven Frill Hem Shift Dress'],
    ['F1', 9.5, 475.513, 430, '8.00'],
    ['F1', 9.5, 513.026, 430, '1,592.00'],
    ['F1', 9.5, 513.026, 384, '1,592.00'],
    ['F1', 9.5, 160, 366, 'VAT at 20%'],
    ['F1', 9.5, 520.949, 366, '318.40'],
    ['F4', 9.5, 160, 348, 'Total'],
    ['F4', 9.5, 513.026, 348, '1,910.40'],
    ['F1', 10, 42, 302, 'Terms: 45 days from invoice date'],
    ['F1', 10, 42, 281, 'Booking Ref : EBUK22709-113'],
    ['F1', 10, 42, 260, 'VAT registration number: GB 439179559'],
  ];
  for (const [font, size, x, y, text] of expected) {
    assert.ok(
      content.includes(`BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`),
      `missing ${text} at ${x},${y}`,
    );
  }
  assert.ok(content.includes('n 42 450 511 15 re f*'));
  assert.ok(content.includes('n 496 393 m 553 393 l S'));
  assert.ok(content.includes('n 496 356 m 553 356 l S'));
  assert.ok(content.includes('1.6 w\nn 496 340 m 553 340 l S'));
});

test('long descriptions wrap and push the totals down', () => {
  const inv = parseInvoiceTask({
    ...TASK_269,
    title: 'INV 280 — Black/Chocolate/Cream/Sage/Burgundy Stretch Woven Boat Neck Long Sleeve Pleated Shift Dress',
    notes: TASK_269.notes.replace('CNO6432', 'CNQ1/CNQ2/CNQ3/CNQ4/CNQ5'),
  });
  const content = pdfContent(buildInvoicePdf(inv, { invoiceDate: '2026-10-01' }));
  const descriptionLines = [...content.matchAll(/1 0 0 1 160 ([\d.]+) Tm \(([^)]*)\) Tj/g)]
    .filter(([, y]) => Number(y) > 400 && Number(y) <= 430);
  assert.ok(descriptionLines.length >= 2);
  for (const [, , line] of descriptionLines) assert.ok(helveticaWidth(line, 9.5) < 320);
  const shift = (descriptionLines.length - 1) * 11.4;
  assert.ok(content.includes(`Tm (Total) Tj`));
  assert.ok(content.includes(`1 0 0 1 160 ${Math.round((348 - shift) * 1000) / 1000} Tm (Total) Tj`));
});

// Mirrors the current statement's layout (rows 1-47).
function statementGrid() {
  const grid = [
    ['DENOVO SOURCING', '', '', '', '', '', '', 'SUMMARY'],
    ['Statement: PrettyLittleThing', '', '', '', '', '', '', 'Overdue', 2914.07],
    ['Statement Date: 29 September 2026', '', '', '', '', '', '', 'Due Soon', 34378.14],
    ['', '', '', '', '', '', '', 'Not Yet Due', 45764.46],
    ['', '', '', '', '', '', '', 'Total Outstanding', 83056.67],
    ['Invoice No', 'Invoice Date', 'PO No', 'Invoice Amount', 'Payment Due', 'Status'],
    ['0193CM', '13-07-2026', 70054559, 21.84, 'IMMEDIATE', 'OVERDUE'],
    ['Subtotal — Overdue (Immediate Terms)', '', '', 1282.07],
    [231, '18-07-2026', 70050251, 1632, '01-09-2026', 'OVERDUE'],
    ['Subtotal — Overdue (Due 01-09-2026)', '', '', 1632],
    [247, '19-08-2026', 70057687, 5762.88, '03-10-2026', 'DUE'],
    ['Subtotal — Due Soon', '', '', 34378.14],
    [272, '25-09-2026', 70067716, 2998.8, '09-11-2026', 'UPCOMING'],
    [273, '25-09-2026', 70069758, 2448, '09-11-2026', 'UPCOMING'],
    ['Subtotal — Not Yet Due', '', '', 45764.46],
    [],
    ['TOTAL OUTSTANDING', '', '', 83056.67],
  ];
  return grid;
}

test('statement plan inserts new invoices at the end of Not Yet Due and rebuilds totals', () => {
  const grid = statementGrid();
  assert.deepEqual([...statementInvoiceNumbers(grid)], ['231', '247', '272', '273']);
  const inv = { ...parseInvoiceTask({ ...TASK_269, title: 'INV 274 — Black Dress' }), invoiceDate: '2026-09-29' };
  const plan = planStatementUpdate(grid, [inv, { ...inv, invoice: 275, po: '70070000', totalPence: 100000 }], { today: '2026-09-29' });
  assert.equal(plan.insertAt, 14);
  assert.equal(plan.count, 2);
  const byRange = Object.fromEntries(plan.updates.map((u) => [u.range, u]));
  assert.deepEqual(byRange['A15:F15'].values, [[274, '29/09/2026', 70062955, 1910.4, '13/11/2026', 'UPCOMING']]);
  assert.equal(byRange['A15:F15'].raw, true);
  assert.deepEqual(byRange['A16:F16'].values[0].slice(0, 4), [275, '29/09/2026', 70070000, 1000]);
  assert.deepEqual(byRange.D8.values, [['=SUM(D7:D7)']]);
  assert.deepEqual(byRange.D10.values, [['=SUM(D9:D9)']]);
  assert.deepEqual(byRange.D12.values, [['=SUM(D11:D11)']]);
  assert.deepEqual(byRange.D17.values, [['=SUM(D13:D16)']]);
  assert.deepEqual(byRange.D19.values, [['=D8+D10+D12+D17']]);
  assert.deepEqual(byRange.I2.values, [['=D8+D10']]);
  assert.deepEqual(byRange.I3.values, [['=D12']]);
  assert.deepEqual(byRange.I4.values, [['=D17']]);
  assert.deepEqual(byRange.I5.values, [['=D19']]);
  assert.deepEqual(byRange.A3.values, [['Statement Date: 29 September 2026']]);
});

test('statement plan keeps text cells as text when the sheet stores them that way', () => {
  const grid = statementGrid().map((row) => (typeof row[0] === 'number' ? [String(row[0]), row[1], String(row[2]), ...row.slice(3)] : row));
  const inv = { ...parseInvoiceTask({ ...TASK_269, title: 'INV 274 — Black Dress' }), invoiceDate: '2026-09-29' };
  const plan = planStatementUpdate(grid, [inv], { today: '2026-09-29' });
  assert.deepEqual(plan.updates[0].values[0].slice(0, 3), ['274', '29/09/2026', '70062955']);
});

test('draft subject follows the hand-sent format', () => {
  assert.equal(draftSubject([274]), 'Invoice 274 and Statement');
  assert.equal(draftSubject([276, 274, 275]), 'Invoices 274-276 and Statement');
  assert.equal(draftSubject([274, 277]), 'Invoices 274, 277 and Statement');
});

test('draft MIME addresses both PLT contacts with PDF attachments', () => {
  const mime = buildMessageMime({
    to: ['Medius PLT Invoices UK <pltukinvoices@prettylittlething.com>', 'Jade Wynne <jade.wynne@prettylittlething.com>'],
    subject: 'Invoice 274 and Statement',
    body: 'Hi,',
    attachments: [{ filename: 'Invoice_0274_PO_70062955.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') }],
  });
  assert.match(mime, /^To: Medius PLT Invoices UK <pltukinvoices@prettylittlething\.com>, Jade Wynne <jade\.wynne@prettylittlething\.com>\r\n/);
  assert.match(mime, /Content-Disposition: attachment; filename="Invoice_0274_PO_70062955\.pdf"/);
});

test('per-SKU packed lines price a multi-price shipment without guessing quantities', () => {
  const items = packingInvoiceLines([
    { sku: 'CNQ1', description: 'Black Dress', ppu: 8, cartons: [{ qty: 100 }] },
    { sku: 'CNQ2', description: 'Cream Dress', ppu: 9.50, cartons: [{ qty: 99 }] },
  ]);
  const task = { ...TASK_269, notes: TASK_269.notes.replace('CNO6432', 'CNQ1/CNQ2').replace('£8.00', '£8.00 / £9.50')
    .replace('EBUK22709-113', `Invoice lines: ${JSON.stringify(items)}\nEBUK22709-113`) };
  const inv = parseInvoiceTask(task);
  assert.equal(inv.problem, undefined);
  assert.equal(inv.netPence, 174050);
  assert.equal(inv.totalPence, 208860);
  const content = pdfContent(buildInvoicePdf(inv, { invoiceDate: '2026-10-08' }));
  assert.match(content, /CNQ1 Black Dress/);
  assert.match(content, /CNQ2 Cream Dress/);
  assert.match(content, /\(9.50\)/);
  assert.match(content, /\(2,088.60\)/);
  const invalid = parseInvoiceTask({ ...task, notes: task.notes.replace('"quantity":99', '"quantity":98') });
  assert.match(invalid.problem, /do not match packed total/);
});

test('missing per-SKU prices and impossible dates fail safely', () => {
  assert.equal(packingInvoiceLines([{ sku: 'A', description: 'Dress', ppu: null, cartons: [{ qty: 1 }] }])[0].unitPricePence, null);
  assert.match(parseInvoiceTask({ ...TASK_269, notes: TASK_269.notes.replace('27-Sep-26', '31-Sep-26') }).problem, /invalid delivery/);
});

test('statement ageing moves whole rows and changes statuses at due-date boundaries', () => {
  const grid = statementGrid();
  grid[8][4] = '08-10-2026'; // due today, moves back from overdue to due soon
  grid[10][4] = '02-10-2026'; // previous Friday, moves from due soon to overdue
  grid[12][4] = '09-10-2026'; // this Friday is included, moves to due soon
  const plan = planStatementAgeing(grid, { today: '2026-10-08', sheetId: 123 });
  assert.equal(plan.requests.length, 3);
  // Apply every planned move to the original grid to verify Sheets indices.
  const actual = structuredClone(grid);
  for (const { moveDimension: move } of plan.requests) {
    const [row] = actual.splice(move.source.startIndex, 1);
    actual.splice(move.destinationIndex > move.source.startIndex ? move.destinationIndex - 1 : move.destinationIndex, 0, row);
    assert.equal(move.source.sheetId, 123);
  }
  assert.deepEqual(actual.map((row) => row[0]), plan.rows.map((row) => row[0]));
  for (const [invoice, status] of [[231, 'DUE'], [247, 'OVERDUE'], [272, 'DUE'], [273, 'UPCOMING']]) {
    const idx = plan.rows.findIndex((row) => row[0] === invoice);
    assert.ok(plan.updates.some((u) => u.range === `F${idx + 1}` && u.values[0][0] === status));
  }
  assert.equal(plan.rows.find((row) => row[0] === '0193CM')[4], 'IMMEDIATE');
  assert.ok(plan.updates.some((u) => u.values[0][0] === 'Subtotal — Overdue'));
});

test('ageing is idempotent and excludes paid invoices from outstanding totals', () => {
  const grid = statementGrid();
  grid[13][5] = 'PAID';
  const first = planStatementAgeing(grid, { today: '2026-10-08', sheetId: 1 });
  const again = planStatementAgeing(first.rows, { today: '2026-10-08', sheetId: 1 });
  assert.equal(again.requests.length, 0);
  assert.equal(again.rows.find((row) => row[0] === 273)[5], 'PAID');
  assert.ok(again.updates.some((u) => String(u.values[0][0]).includes('SUMIFS')));
});

test('invalid due dates and absent destination sections stop ageing before a write', () => {
  const grid = statementGrid();
  grid[12][4] = '31-02-2026';
  assert.throws(() => planStatementAgeing(grid, { today: '2026-10-08', sheetId: 1 }), /invalid payment due date/);
  const missingSection = statementGrid().filter((row) => row[0] !== 'Subtotal — Due Soon');
  missingSection.find((row) => row[0] === 272)[4] = '02-10-2026';
  assert.throws(() => planStatementAgeing(missingSection, { today: '2026-10-01', sheetId: 1 }), /no due soon/);
});

test('Friday remittance includes Friday due dates and ages unpaid invoices after the run', () => {
  assert.equal(remittanceFriday('2026-10-05'), '2026-10-09');
  assert.equal(remittanceFriday('2026-10-09'), '2026-10-09');
  assert.equal(remittanceFriday('2026-10-10'), '2026-10-16');
  assert.equal(fridayOfWeek('2026-10-08'), '2026-10-09');
  assert.equal(fridayOfWeek('2026-10-11'), '2026-10-09');
  const grid = statementGrid();
  grid[12][4] = '05-10-2026';
  grid[13][4] = '09-10-2026';
  for (const day of ['2026-10-05', '2026-10-08', '2026-10-09']) {
    const plan = planStatementAgeing(grid, { today: day, sheetId: 1 });
    assert.equal(plan.rows.find((row) => row[0] === 272)[5], 'DUE');
    assert.equal(plan.rows.find((row) => row[0] === 273)[5], 'DUE');
  }
  const saturday = planStatementAgeing(grid, { today: '2026-10-10', sheetId: 1 });
  assert.equal(saturday.rows.find((row) => row[0] === 272)[5], 'OVERDUE');
  assert.equal(saturday.rows.find((row) => row[0] === 273)[5], 'OVERDUE');
  assert.equal(remittanceFriday('2026-12-31'), '2027-01-01');
});
