// Regression tests for lib/domain.mjs. Most cases are lifted from real bugs
// fixed in July 2026 — see the referenced commits — so a failure here means
// one of those bugs is back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_MARKER,
  normalisePo,
  validateDocket,
  parseBookingTask,
  findBooking,
  findBookingTask,
  combineDescriptions,
  extractInvoiceNumber,
  extractPackingListFields,
  cartonRows,
  buildPackingListWorkbook,
  formatUk,
  addDaysUTC,
} from '../lib/domain.mjs';

// ── normalisePo ──────────────────────────────────────────────────────────────
// DB POs are zero-padded to 10 digits; sheets and notes carry them unpadded
// (4b07bf8: matching failed on the unpadded form).

test('normalisePo pads unpadded POs to the 10-digit DB form', () => {
  assert.equal(normalisePo('70053828'), '0070053828');
});

test('normalisePo keeps already-padded POs unchanged', () => {
  assert.equal(normalisePo('0070053828'), '0070053828');
});

test('normalisePo strips non-digits (labels, punctuation)', () => {
  assert.equal(normalisePo('PO 70-053-828'), '0070053828');
  assert.equal(normalisePo(70053828), '0070053828');
});

test('normalisePo returns null when there are no digits', () => {
  assert.equal(normalisePo(''), null);
  assert.equal(normalisePo(null), null);
  assert.equal(normalisePo('n/a'), null);
});

// ── parseBookingTask ─────────────────────────────────────────────────────────
// b9122c6: combined "Sun 05-Jul-26 11:00" lines; f328c14: legacy tasks carry
// date and time as two separate lines.

test('parseBookingTask reads the combined date+time line', () => {
  const parsed = parseBookingTask({ notes: '70053828\nCNO7708\nSun 12-Jul-26 11:00\nEBUK21207-68' });
  assert.deepEqual(parsed, { date: '2026-07-12', time: '11:00', ref: 'EBUK21207-68' });
});

test('parseBookingTask reads legacy separate date and time lines', () => {
  const parsed = parseBookingTask({ notes: '0070053828\n2026-07-12\n11:00\nEBUK21207-68' });
  assert.deepEqual(parsed, { date: '2026-07-12', time: '11:00', ref: 'EBUK21207-68' });
});

test('parseBookingTask returns nulls for notes with no recognisable lines', () => {
  assert.deepEqual(parseBookingTask({ notes: '' }), { date: null, time: null, ref: null });
  assert.deepEqual(parseBookingTask({}), { date: null, time: null, ref: null });
});

test('parseBookingTask does not misread the time line as the booking ref', () => {
  // Legacy notes ending in the time line: ref must be null, not "11:00".
  const parsed = parseBookingTask({ notes: '0070053828\n2026-07-12\n11:00' });
  assert.equal(parsed.ref, null);
  assert.equal(parsed.date, '2026-07-12');
});

// ── findBooking (draft-packing-list side) ────────────────────────────────────
// f328c14: legacy notes carry no SKU — the INV 224 sheet's booking fields
// came out blank because the matcher required one.

const legacyTask = {
  title: 'Black Petite Black Scoop Neck Sleeveless Maxi Dress',
  notes: '0070053828\n2026-07-12\n11:00\nEBUK21207-68',
};
const combinedTask = {
  title: 'Red/Brown Puffball Mini Dress',
  notes: '70050254\nCNQ1111/CNQ2222\nSun 12-Jul-26 11:00\nEBUK21207-68',
};

test('findBooking matches a legacy task (padded PO, no SKU in notes)', () => {
  const booking = findBooking([legacyTask], '0070053828', 'CNO7708');
  assert.deepEqual(booking, { date: '2026-07-12', time: '11:00', ref: 'EBUK21207-68' });
});

test('findBooking matches unpadded PO in notes against the padded DB PO', () => {
  const booking = findBooking([combinedTask], '0070050254', 'CNQ1111');
  assert.equal(booking.ref, 'EBUK21207-68');
});

test('findBooking prefers the SKU match when several tasks share the PO', () => {
  const other = { title: 'other', notes: '70053828\nZZZ9999\nSun 12-Jul-26 09:00\nREF-OTHER' };
  const withSku = { title: 'right', notes: '70053828\nCNO7708\nSun 12-Jul-26 11:00\nREF-RIGHT' };
  const booking = findBooking([other, withSku], '0070053828', 'CNO7708');
  assert.equal(booking.ref, 'REF-RIGHT');
});

test('findBooking returns null when several PO matches exist and none name the SKU', () => {
  const a = { title: 'a', notes: '0070053828\n2026-07-12\n11:00\nREF-A' };
  const b = { title: 'b', notes: '0070053828\n2026-07-13\n12:00\nREF-B' };
  assert.equal(findBooking([a, b], '0070053828', 'CNO7708'), null);
});

test('findBooking returns null when nothing matches the PO', () => {
  assert.equal(findBooking([legacyTask], '0070999999', 'CNO7708'), null);
});

// ── findBookingTask (complete-order side) ────────────────────────────────────
// f328c14: same legacy-notes gap skipped the INV-stamping entirely; the old
// matcher also demanded style_no in notes, which no notes format carries.

const order = { po: '0070053828', style: 'CNO7708', style_no: null };

test('findBookingTask matches a legacy no-SKU task by lone PO', () => {
  assert.equal(findBookingTask([legacyTask], order, '224'), legacyTask);
});

test('findBookingTask prefers the task naming the SKU', () => {
  const other = { title: 'other', notes: '70053828\nZZZ9999\nref' };
  const withSku = { title: 'right', notes: '70053828\nCNO7708\nref' };
  assert.equal(findBookingTask([other, withSku], order, '224'), withSku);
});

test('findBookingTask falls back to style_no when the SKU is not in any notes', () => {
  const styleNoOrder = { po: '0070017948', style: 'CNN8143', style_no: 'D5641' };
  const task = { title: 't', notes: '70017948\nD5641\nref' };
  const decoy = { title: 'd', notes: '70017948\nother\nref' };
  assert.equal(findBookingTask([decoy, task], styleNoOrder, '87'), task);
});

test('findBookingTask never re-stamps a task already carrying the invoice (idempotency)', () => {
  const stamped = { ...legacyTask, title: 'INV 224 — Black Petite Black Scoop Neck Sleeveless Maxi Dress' };
  assert.equal(findBookingTask([stamped], order, '224'), undefined);
});

test('findBookingTask refuses to guess between several no-SKU PO matches', () => {
  const a = { title: 'a', notes: '0070053828\nx' };
  const b = { title: 'b', notes: '0070053828\ny' };
  assert.equal(findBookingTask([a, b], order, '224'), undefined);
});

// ── combineDescriptions ──────────────────────────────────────────────────────

test('combineDescriptions strips the colour prefix and re-adds the colour list', () => {
  const groups = [{ colour: 'BLACK' }];
  const orders = [{ description: 'Black Petite Black Scoop Neck Sleeveless Maxi Dress' }];
  assert.equal(
    combineDescriptions(groups, orders),
    'Black Petite Black Scoop Neck Sleeveless Maxi Dress',
  );
});

test('combineDescriptions joins distinct colours with a slash', () => {
  const groups = [{ colour: 'LEMON' }, { colour: 'BLACK' }];
  const orders = [{ description: 'Lemon Plus Scoop Neck Sleeveless Maxi Dress' }];
  assert.equal(
    combineDescriptions(groups, orders),
    'Lemon/Black Plus Scoop Neck Sleeveless Maxi Dress',
  );
});

test('combineDescriptions falls back to the raw description without colours', () => {
  assert.equal(combineDescriptions([{}], [{ description: 'Some Dress' }]), 'Some Dress');
});

// ── extractInvoiceNumber ─────────────────────────────────────────────────────
// 909936d: HTML-flattened replies collapse newlines, defeating '>'-quoting
// and line-anchored matches — the DATA_MARKER cut has to save the day.

test('extractInvoiceNumber reads a bare number reply', () => {
  assert.equal(extractInvoiceNumber('224'), '224');
  assert.equal(extractInvoiceNumber('  #224  '), '224');
});

test('extractInvoiceNumber reads labelled forms', () => {
  assert.equal(extractInvoiceNumber('INV 220'), '220');
  assert.equal(extractInvoiceNumber('inv no 220'), '220');
  assert.equal(extractInvoiceNumber('Invoice #221 attached'), '221');
  assert.equal(extractInvoiceNumber('inv: 222'), '222');
});

test('extractInvoiceNumber ignores ">"-quoted content', () => {
  const body = '224\n> please reply with the INV number, e.g. 999\n> 123';
  assert.equal(extractInvoiceNumber(body), '224');
});

test('extractInvoiceNumber ignores everything below an "On ... wrote:" header', () => {
  const body = '225\nOn Thu, 10 Jul 2026 at 13:00, denovogb wrote:\n123\ninv 999';
  assert.equal(extractInvoiceNumber(body), '225');
});

test('extractInvoiceNumber reads labelled replies flattened onto one line', () => {
  // A reply with no text/plain part is flattened to a single line: the
  // human's "INV 226", the quoted ask, and the data payload all run
  // together, so neither '>'-filtering nor the line-anchored bare match
  // can help — only the labelled match on the fresh text works.
  const body =
    `INV 226 On Thu, 10 Jul 2026 denovogb wrote: Read from the docket photo(s) — PO 70053828: ` +
    `Reply to this email with the invoice number (e.g. "220") ` +
    `${DATA_MARKER} {"po":"0070053828","groups":[{"cartons":[{"size":"16","qty":9}]}]}`;
  assert.equal(extractInvoiceNumber(body), '226');
});

test('extractInvoiceNumber finds nothing in a flattened reply with no fresh number', () => {
  // Same flattening, but the human wrote no number: the quoted ask's
  // example ("220") and the digits inside the machine payload must not be
  // mistaken for an invoice number.
  const body =
    `thanks, will send it later On Thu, 10 Jul 2026 denovogb wrote: ` +
    `Reply to this email with the invoice number (e.g. "220") ` +
    `${DATA_MARKER} {"po":"0070053828","groups":[{"cartons":[{"size":"16","qty":9}]}]}`;
  assert.equal(extractInvoiceNumber(body), null);
});

test('extractInvoiceNumber returns null when only quoted content has numbers', () => {
  const body = `thanks!\n> 123\nOn Thu wrote:\n456 ${DATA_MARKER} {"po":"0070053828"}`;
  assert.equal(extractInvoiceNumber(body), null);
});

// ── validateDocket ───────────────────────────────────────────────────────────

const goodDocket = {
  po: '0070053828',
  sku: 'CNO7708',
  cartons: [{ size: '16', qty: 9 }, { size: '18', qty: 18 }],
  written_total: 27,
  written_boxes: 2,
};

test('validateDocket accepts a docket whose checksums agree', () => {
  assert.equal(validateDocket(goodDocket), null);
});

test('validateDocket rejects unpadded POs', () => {
  assert.match(validateDocket({ ...goodDocket, po: '70053828' }), /not a 10-digit number/);
});

test('validateDocket rejects a wrong written total', () => {
  assert.match(validateDocket({ ...goodDocket, written_total: 26 }), /add up to 27/);
});

test('validateDocket rejects a wrong written box count', () => {
  assert.match(validateDocket({ ...goodDocket, written_boxes: 3 }), /2 cartons read/);
});

test('validateDocket requires a written total to check against', () => {
  assert.match(validateDocket({ ...goodDocket, written_total: null }), /no handwritten grand total/);
});

test('validateDocket surfaces the model-reported problem for unreadable pages', () => {
  assert.equal(validateDocket({ unreadable: true, problem: 'photo too blurry' }), 'photo too blurry');
});

// "s"-prefix small-box checksum: mirrors the written_total/written_boxes
// pattern above -- optional overall (most dockets have no small boxes), but
// required once at least one carton is actually marked small.

test('validateDocket accepts a docket with a matching small-box count', () => {
  const docket = {
    ...goodDocket,
    cartons: [{ size: '16', qty: 9 }, { size: '18', qty: 18, small: true }],
    written_boxes: 2,
    written_small_boxes: 1,
  };
  assert.equal(validateDocket(docket), null);
});

test('validateDocket rejects a wrong written small-box count', () => {
  const docket = {
    ...goodDocket,
    cartons: [{ size: '16', qty: 9 }, { size: '18', qty: 18, small: true }],
    written_boxes: 2,
    written_small_boxes: 2,
  };
  assert.match(validateDocket(docket), /1 small-box carton\(s\) read but the written small-box count is 2/);
});

test('validateDocket requires a written small-box count once a carton is marked small', () => {
  const docket = {
    ...goodDocket,
    cartons: [{ size: '16', qty: 9 }, { size: '18', qty: 18, small: true }],
    written_boxes: 2,
  };
  assert.match(validateDocket(docket), /marked small.*no handwritten small-box count/);
});

test('validateDocket does not require a small-box count when no carton is marked small', () => {
  assert.equal(validateDocket(goodDocket), null); // goodDocket has no written_small_boxes and no small cartons
});

// ── cartonRows ───────────────────────────────────────────────────────────────
// Layout rule from the hand-made sheets: consecutive same-size/same-qty
// cartons collapse into one row with a carton range.

test('cartonRows groups consecutive identical cartons and numbers across groups', () => {
  const { rows, totalBoxes, totalPcs } = cartonRows([
    {
      colour: 'LEMON',
      cartons: [
        { size: 16, qty: 9 },
        { size: 18, qty: 18 },
        { size: 18, qty: 18 },
        { size: 20, qty: 17 },
      ],
    },
    { colour: 'BLACK', cartons: [{ size: 16, qty: 5 }] },
  ]);
  assert.deepEqual(rows, [
    { colourLabel: 'LEMON', size: '16', qty: 9, boxes: 1, cartonType: 'BDCM1', pcs: 9, cartons: '1' },
    { colourLabel: '', size: '18', qty: 18, boxes: 2, cartonType: 'BDCM1', pcs: 36, cartons: '2-3' },
    { colourLabel: '', size: '20', qty: 17, boxes: 1, cartonType: 'BDCM1', pcs: 17, cartons: '4' },
    { colourLabel: 'BLACK', size: '16', qty: 5, boxes: 1, cartonType: 'BDCM1', pcs: 5, cartons: '5' },
  ]);
  assert.equal(totalBoxes, 5);
  assert.equal(totalPcs, 67);
});

test('cartonRows does not merge same-size cartons with different quantities', () => {
  const { rows } = cartonRows([
    { colour: 'BLACK', cartons: [{ size: 22, qty: 7 }, { size: 22, qty: 15 }] },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.cartons), ['1', '2']);
});

// "s"-prefix convention: a carton marked `small: true` is a half-height
// BDCM3 box. Two otherwise-identical cartons must NOT merge into one row
// if their carton type differs -- see domain.mjs cartonRows.

test('cartonRows keeps same-size/same-qty cartons separate when carton type differs', () => {
  const { rows } = cartonRows([
    {
      colour: 'TAUPE',
      cartons: [
        { size: '8', qty: 20, small: false },
        { size: '8', qty: 20, small: true },
      ],
    },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.cartonType), ['BDCM1', 'BDCM3']);
  assert.deepEqual(rows.map((r) => r.cartons), ['1', '2']);
});

test('cartonRows still merges consecutive small cartons of the same size/qty', () => {
  const { rows } = cartonRows([
    {
      colour: 'TAUPE',
      cartons: [
        { size: '8', qty: 10, small: true },
        { size: '8', qty: 10, small: true },
      ],
    },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { colourLabel: 'TAUPE', size: '8', qty: 10, boxes: 2, cartonType: 'BDCM3', pcs: 20, cartons: '1-2' });
});

// ── buildPackingListWorkbook + extractPackingListFields round trip ───────────
// The completion job reads PO/SKU/invoice from inside generated sheets; a
// layout change that breaks the label→value-in-next-cell shape kills the
// whole Booked→Completed pipeline. This pins that contract.

// Serialise and reload before extracting: the completion job always parses
// sheets from downloaded bytes, and in-memory formula cells behave
// differently from reloaded ones.
async function reload(wb) {
  const ExcelJS = (await import('exceljs')).default;
  const buffer = await wb.xlsx.writeBuffer();
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(buffer);
  return reloaded;
}

function sampleWorkbook() {
  return buildPackingListWorkbook({
    invoice: '224',
    dispatchDate: '11/07/2026',
    deliveryDate: '12/07/2026',
    bookingRef: 'EBUK21207-68',
    poDisplay: '70053828',
    internalCode: 'CNO7708',
    description: 'Black Petite Black Scoop Neck Sleeveless Maxi Dress',
    groups: [
      { colour: 'BLACK', sku: 'CNO7708', cartons: [{ size: '16', qty: 9 }, { size: '18', qty: 18 }] },
    ],
  });
}

test('generated sheets round-trip through extractPackingListFields', async () => {
  const wb = await reload(sampleWorkbook());
  const fields = extractPackingListFields(wb.worksheets[0]);
  assert.equal(normalisePo(fields.po), '0070053828');
  assert.equal(fields.sku, 'CNO7708');
  assert.equal(fields.invoice, '224');
});

test('generated sheets keep the hand-made layout anchors', () => {
  const ws = sampleWorkbook().worksheets[0];
  assert.equal(ws.getCell('C1').value, 'PACKING LIST');
  assert.equal(ws.getCell('F2').value, 224); // numeric like the hand-made sheets
  assert.equal(ws.getCell('A14').value, 'Colour Breakdown');
  assert.equal(ws.getCell('A15').value, 'BLACK');
  // Totals pinned to row 40 with live formulas over the template area.
  assert.equal(ws.getCell('A40').value, 'Total Boxes/Pcs.');
  assert.equal(ws.getCell('D40').value.formula, 'SUM(D15:D39)');
  assert.equal(ws.getCell('D40').value.result, 2);
  assert.equal(ws.getCell('E14').value, 'Carton Type');
  assert.equal(ws.getCell('E15').value, 'BDCM1');
  assert.equal(ws.getCell('F40').value.result, 27);
  // Footer starts two rows below the totals.
  assert.match(String(ws.getCell('A42').value), /denovosourcing@gmail\.com/);
});

test('generated sheets write the real carton type per row, not a blanket BDCM1', () => {
  const wb = buildPackingListWorkbook({
    invoice: '224', dispatchDate: '', deliveryDate: '', bookingRef: '',
    poDisplay: '70056980', internalCode: 'CNR0463', description: 'Taupe Maxi Dress',
    groups: [
      {
        colour: 'TAUPE',
        sku: 'CNR0463',
        cartons: [
          { size: '8', qty: 20, small: false },
          { size: '8', qty: 15, small: true },
        ],
      },
    ],
  });
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell('E15').value, 'BDCM1');
  assert.equal(ws.getCell('E16').value, 'BDCM3');
});

test('the totals row moves down only when a delivery overflows the template', () => {
  const cartons = Array.from({ length: 30 }, (_, i) => ({ size: String(i), qty: 1 }));
  const wb = buildPackingListWorkbook({
    invoice: '1', dispatchDate: '', deliveryDate: '', bookingRef: '',
    poDisplay: '70000000', internalCode: 'X', description: 'X',
    groups: [{ colour: 'BLACK', sku: 'X', cartons }],
  });
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell('A46').value, 'Total Boxes/Pcs.'); // 15 + 30 rows + 1
  assert.equal(ws.getCell('D46').value.formula, 'SUM(D15:D45)');
});

// ── date helpers ─────────────────────────────────────────────────────────────

test('formatUk renders ISO dates as dd/mm/yyyy', () => {
  assert.equal(formatUk('2026-07-12'), '12/07/2026');
});

test('addDaysUTC shifts ISO dates across month boundaries', () => {
  assert.equal(addDaysUTC('2026-07-12', -1), '2026-07-11');
  assert.equal(addDaysUTC('2026-08-01', -1), '2026-07-31');
});
