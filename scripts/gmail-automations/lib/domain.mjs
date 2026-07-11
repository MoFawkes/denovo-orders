// Pure business rules shared by the packing-list automations: PO
// normalisation, booking-task parsing/matching, invoice-number extraction,
// docket validation, and packing-list workbook construction. Nothing here
// talks to Gmail, Drive, Tasks, or Supabase — every function takes plain
// inputs and returns values, so the whole module is unit-testable
// (see ../tests/). API plumbing lives in google.mjs / claude.mjs and the
// orchestration in the top-level scripts.
import ExcelJS from 'exceljs';

// Marks the machine-readable block draft-packing-list's Phase A embeds in
// its own reply.
export const DATA_MARKER = '----- automation data v1 (do not edit below this line) -----';

// ── Purchase orders ──────────────────────────────────────────────────────────

// DB POs are 10-digit zero-padded strings; sheets and task notes carry them
// unpadded (or with stray punctuation).
export function normalisePo(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? digits.padStart(10, '0') : null;
}

// ── Docket extraction validation ─────────────────────────────────────────────

export function validateDocket(docket) {
  if (docket.unreadable) return docket.problem || 'photo unreadable';
  if (!/^\d{10}$/.test(docket.po ?? '')) return `PO "${docket.po}" is not a 10-digit number`;
  if (!docket.sku) return 'no SKU found on the docket';
  if (!Array.isArray(docket.cartons) || docket.cartons.length === 0) {
    return 'no handwritten carton quantities found';
  }
  const sum = docket.cartons.reduce((t, c) => t + (Number(c.qty) || 0), 0);
  if (docket.written_total != null && sum !== Number(docket.written_total)) {
    return `carton quantities add up to ${sum} but the written total is ${docket.written_total}`;
  }
  if (docket.written_total == null) {
    return 'no handwritten grand total on the page to check the cartons against';
  }
  if (docket.written_boxes != null && docket.cartons.length !== Number(docket.written_boxes)) {
    return `${docket.cartons.length} cartons read but the written box count is ${docket.written_boxes}`;
  }
  return null;
}

// ── Booking Google Tasks ─────────────────────────────────────────────────────

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Booking Google Tasks (created by mark-order-booked.mjs) carry newline-
// separated notes: unpadded PO, SKU(s), a combined date+time line formatted
// "Sun 05-Jul-26 11:00", and the booking reference. Recognise lines by shape
// rather than fixed position.
export function parseBookingTask(task) {
  const lines = (task.notes ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const dtLine = lines.find((l) => /^\w{3}\s+\d{2}-\w{3}-\d{2}\s+\d{1,2}:\d{2}$/.test(l));
  // Tasks created before the combined format carry the date and time as two
  // separate lines instead: "2026-07-12" then "11:00".
  const dateLine = lines.find((l) => /^\d{4}-\d{2}-\d{2}$/.test(l));
  const timeLine = lines.find((l) => /^\d{1,2}:\d{2}$/.test(l));
  let date = null;
  let time = null;
  if (dtLine) {
    const m = dtLine.match(/^\w{3}\s+(\d{2})-(\w{3})-(\d{2})\s+(\d{1,2}:\d{2})$/);
    const monthIdx = MONTH_ABBR.findIndex((mo) => mo.toLowerCase() === m[2].toLowerCase());
    if (monthIdx !== -1) {
      date = `20${m[3]}-${String(monthIdx + 1).padStart(2, '0')}-${m[1]}`;
      time = m[4];
    }
  } else if (dateLine) {
    date = dateLine;
    time = timeLine ?? null;
  }
  const last = lines[lines.length - 1];
  const ref =
    lines.length > 1 && last && last !== dtLine && last !== dateLine && last !== timeLine ? last : null;
  return { date, time, ref };
}

export function findBooking(openTasks, po, styleNo) {
  const poUnpadded = po.replace(/^0+(?=\d)/, '');
  const poMatches = openTasks.filter(
    (t) => t.notes?.includes(po) || t.notes?.includes(poUnpadded),
  );
  // Notes from before the combined-task format carry no SKU at all, so the
  // SKU is a preference, not a requirement: fall back to a lone PO match
  // rather than treating the order as unbooked.
  const task =
    poMatches.find((t) => styleNo && t.notes.includes(styleNo)) ??
    (poMatches.length === 1 ? poMatches[0] : undefined);
  return task ? parseBookingTask(task) : null;
}

// The complete-order side of the same matching problem: given an order and
// the invoice being stamped, pick the task to rename/tick. PO is matched
// against both the padded (DB) and unpadded forms; the SKU (then style_no)
// is a preference with a lone-PO-match fallback, same reasoning as
// findBooking. Tasks already carrying "INV <n>" are skipped so a rerun can
// never double-stamp.
export function findBookingTask(openTasks, order, invoice) {
  const poUnpadded = order.po.replace(/^0+(?=\d)/, '');
  const poMatches = openTasks.filter(
    (t) =>
      (t.notes?.includes(order.po) || t.notes?.includes(poUnpadded)) &&
      !t.title?.includes(`INV ${invoice}`),
  );
  return (
    poMatches.find((t) => order.style && t.notes.includes(order.style)) ??
    poMatches.find((t) => order.style_no && t.notes.includes(order.style_no)) ??
    (poMatches.length === 1 ? poMatches[0] : undefined)
  );
}

// ── Descriptions and invoice numbers ─────────────────────────────────────────

// Combined display text for multi-colour deliveries, mirroring how the
// hand-made sheets (and the booking tasks) name them: distinct colours
// joined with '/', then the shared garment text with the colour word
// stripped off the front of the first order's description.
export function combineDescriptions(groups, orderByGroup) {
  const colours = groups.map((g) => {
    const c = (g.colour ?? '').toLowerCase();
    return c ? c[0].toUpperCase() + c.slice(1) : '';
  }).filter(Boolean);
  const first = orderByGroup[0]?.description ?? '';
  const firstColour = groups[0]?.colour ?? '';
  const base = firstColour && first.toLowerCase().startsWith(firstColour.toLowerCase())
    ? first.slice(firstColour.length).trim()
    : first;
  return colours.length > 0 ? `${colours.join('/')} ${base}`.trim() : first;
}

// Pulls the INV number out of the human's reply: "220", "INV 220",
// "inv no 220" etc, ignoring quoted content from the automation's own
// earlier message.
export function extractInvoiceNumber(text) {
  const stripped = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('>'))
    .join('\n')
    // Everything below a quote header ("On ... wrote:") is quoted content.
    .split(/^On .+wrote:/m)[0];
  // extractPlainTextBody's HTML fallback collapses all whitespace (including
  // newlines) into single spaces, which defeats both the '>' filtering above
  // and the line-anchored bare-number match below when a reply has no
  // text/plain part. DATA_MARKER only ever appears in our own quoted
  // message, survives that flattening intact (plain ASCII), and this cut is
  // resilient either way -- if the marker isn't present (nothing quoted,
  // or already stripped above), the text is used as-is.
  const fresh = stripped.split(DATA_MARKER)[0];
  const labelled = fresh.match(/\binv(?:oice)?\.?\s*(?:no\.?|number|#)?\s*[:\-]?\s*(\d{1,6})\b/i);
  if (labelled) return labelled[1];
  const bare = fresh.match(/^\s*#?(\d{1,6})\s*$/m);
  return bare ? bare[1] : null;
}

// ── Packing-list spreadsheets ────────────────────────────────────────────────

// Walks a sheet and pulls the labelled fields regardless of exact layout:
// each label ("PO Reference", "Internal Code", "Delivery Note No.") is
// followed by its value in the next non-empty cell of the same row.
export function extractPackingListFields(worksheet) {
  const fields = {};
  const wanted = [
    ['po', /po\s*reference/i],
    ['sku', /internal\s*code/i],
    ['invoice', /delivery\s*note\s*no/i],
  ];
  worksheet.eachRow((row) => {
    const values = [];
    row.eachCell({ includeEmpty: false }, (cell) => {
      // Merged-but-empty ranges (both the hand-made sheets and generated
      // ones have them) yield slave cells whose .text getter throws on the
      // null master value — treat them as the empty cells they are.
      if (cell.value == null) return;
      values.push(cell.text ?? String(cell.value ?? ''));
    });
    for (const [key, re] of wanted) {
      if (fields[key] !== undefined) continue;
      const idx = values.findIndex((v) => re.test(v));
      if (idx !== -1 && idx + 1 < values.length) {
        fields[key] = String(values[idx + 1]).trim();
      }
    }
  });
  return fields;
}

// ── Packing-list workbook (mirrors the hand-made "INV <n> ..." sheets) ──────
// Layout copied from the existing sheets in denovogb's Drive; the labelled
// field rows (PO Reference / Internal Code / Delivery Note No.) are what
// extractPackingListFields matches on, so their label-then-value-in-next-cell
// shape must not change.

// Groups consecutive cartons of the same size and quantity into one row
// ("18, 2 boxes, cartons 3-4"), numbering cartons sequentially across groups.
export function cartonRows(groups) {
  const rows = [];
  let carton = 0;
  let totalBoxes = 0;
  let totalPcs = 0;
  for (const group of groups) {
    const groupRows = [];
    for (const c of group.cartons) {
      const prev = groupRows[groupRows.length - 1];
      if (prev && prev.size === String(c.size) && prev.qty === Number(c.qty)) {
        prev.boxes += 1;
      } else {
        groupRows.push({ size: String(c.size), qty: Number(c.qty), boxes: 1 });
      }
    }
    groupRows.forEach((r, i) => {
      const first = carton + 1;
      carton += r.boxes;
      totalBoxes += r.boxes;
      totalPcs += r.qty * r.boxes;
      rows.push({
        colourLabel: i === 0 ? group.colour : '',
        size: r.size,
        qty: r.qty,
        boxes: r.boxes,
        pcs: r.qty * r.boxes,
        cartons: r.boxes === 1 ? String(first) : `${first}-${carton}`,
      });
    });
  }
  return { rows, totalBoxes, totalPcs };
}

export function buildPackingListWorkbook({
  invoice,
  dispatchDate,
  deliveryDate,
  bookingRef,
  poDisplay,
  internalCode,
  description,
  groups,
}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.columns = [
    { width: 18.43 }, { width: 11.71 }, { width: 23.57 }, { width: 13 }, { width: 20 }, { width: 19.71 },
  ];

  const M = { style: 'medium', color: { argb: 'FF000000' } };
  const T = { style: 'thin', color: { argb: 'FF000000' } };
  const RED = { argb: 'FFFF0000' };
  const georgia = (size, extra = {}) => ({ name: 'Georgia', size, ...extra });
  const arial = (extra = {}) => ({ name: 'Arial', ...extra });
  const calibri = { name: 'Calibri', size: 11 };
  const centre = { horizontal: 'center', vertical: 'bottom' };
  const middle = { horizontal: 'center', vertical: 'middle' };
  const asNumber = (v) => (/^\d+$/.test(String(v)) ? Number(v) : v);

  const set = (addr, value, { font, border, alignment, numFmt, fill } = {}) => {
    const cell = ws.getCell(addr);
    if (value !== undefined) cell.value = value;
    if (font) cell.font = font;
    if (border) cell.border = border;
    if (alignment) cell.alignment = alignment;
    if (numFmt) cell.numFmt = numFmt;
    if (fill) cell.fill = fill;
  };

  // Title, plus the top edge of the boxed Delivery Note table in column F.
  ws.mergeCells('C1:D1');
  set('C1', 'PACKING LIST', { font: georgia(16, { bold: true, color: RED }), alignment: centre });
  set('F1', ' ', { border: { bottom: M } });

  // Left header block (Georgia) and the medium-boxed E/F fields (Arial).
  ws.mergeCells('B2:C2');
  set('A2', 'Customer:', { font: georgia(13, { bold: true }), alignment: centre });
  set('B2', 'Pretty Little Thing', { font: georgia(13) });
  set('E2', 'Delivery Note No.', { font: arial({ bold: true }), border: { top: M, bottom: M, left: M, right: M }, alignment: centre });
  set('F2', asNumber(invoice), { font: arial(), border: { right: M, bottom: M }, alignment: { horizontal: 'center' } });

  ws.mergeCells('B3:D3');
  set('A3', 'Delivery Address :', { font: georgia(9, { bold: true }) });
  set('B3', 'Shepcote Lane, Sheffield  S9 1RF', {
    font: georgia(9, { color: { argb: 'FF222222' } }),
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' }, bgColor: { argb: 'FFFFFFFF' } },
  });
  set('D3', undefined, { border: { right: M } });
  set('E3', 'Dispatch Date', { font: arial({ bold: true }), border: { right: M, bottom: M }, alignment: centre });
  set('F3', dispatchDate ?? '', { font: arial(), border: { right: M, bottom: M }, alignment: { horizontal: 'center' } });

  ws.mergeCells('B4:C4');
  set('E4', 'Delivery Date', { font: arial({ bold: true }), border: { right: M, bottom: M }, alignment: centre });
  set('F4', deliveryDate ?? '', { font: arial(), border: { right: M, bottom: M }, alignment: { horizontal: 'center' } });

  ws.mergeCells('B5:C5');
  set('A5', 'SUPPLIER:', { font: georgia(13, { bold: true }), alignment: centre });
  set('B5', 'DENOVO SOURCING', { font: georgia(13) });
  set('E5', 'Booking Ref.', { font: arial({ bold: true }), border: { right: M, bottom: M }, alignment: centre });
  set('F5', bookingRef ?? '', { font: arial(), border: { top: M, bottom: M, left: M, right: M }, alignment: { horizontal: 'center' } });

  set('B6', '25 Temple Building, Temple Road', { font: georgia(9) });
  ws.mergeCells('B7:C7');
  set('B7', 'Leicester', { font: georgia(9) });
  set('B8', 'LE5 4JG', { font: georgia(9) });

  // Separator rule under the supplier block.
  ws.mergeCells('A9:B9');
  set('A9', undefined, { border: { bottom: M } });
  set('B9', undefined, { border: { bottom: M } });

  // Labelled field rows — label with the value in the next cell; this shape
  // is what extractPackingListFields matches on, do not change.
  ws.mergeCells('B10:C10');
  set('A10', 'PO Reference', { font: arial(), border: { left: M, right: M, bottom: T }, alignment: centre });
  set('B10', asNumber(poDisplay), { font: arial(), border: { bottom: T }, alignment: centre });
  set('C10', undefined, { border: { right: M, bottom: T } });

  ws.mergeCells('B11:C11');
  ws.mergeCells('D11:E11');
  set('A11', 'Internal Code', { font: arial(), border: { left: M, right: T, bottom: T }, alignment: centre });
  set('B11', internalCode, { font: arial(), border: { bottom: T }, alignment: centre });
  set('C11', undefined, { border: { right: T, bottom: T } });
  set('E11', undefined, { border: { right: T, bottom: T } });

  ws.mergeCells('B12:E12');
  set('A12', 'Description', { font: arial(), border: { left: M, right: T, bottom: T }, alignment: centre });
  set('B12', description, { font: arial(), border: { bottom: T }, alignment: { vertical: 'bottom', wrapText: true } });
  set('C12', undefined, { border: { bottom: T } });
  set('D12', undefined, { border: { bottom: T } });
  set('E12', undefined, { border: { right: T, bottom: T } });

  // Carton table header (row 14; row 13 stays blank).
  set('A14', 'Colour Breakdown', { font: arial({ bold: true }), border: { left: M, right: M, bottom: M }, alignment: centre });
  set('B14', 'Size', { font: arial({ bold: true }), border: { right: M, bottom: T }, alignment: centre });
  set('C14', 'Qty per Box', { font: arial({ bold: true }), border: { right: M, bottom: T }, alignment: centre });
  set('D14', 'No of Boxes', { font: arial({ bold: true }), border: { right: M, bottom: T }, alignment: centre });
  set('E14', 'Total Pcs', { font: arial({ bold: true, color: RED }), border: { right: T, bottom: T }, alignment: centre });
  set('F14', 'Carton Nos.', { font: arial({ bold: true }), border: { right: M, bottom: T }, alignment: centre });

  // Data rows: sizes/qty-per-box/carton numbers are stored as text (like the
  // hand-made sheets); Total Pcs is a live formula so edits recompute.
  const { rows, totalBoxes, totalPcs } = cartonRows(groups);
  const dataStart = 15;
  rows.forEach((r, i) => {
    const rn = dataStart + i;
    if (r.colourLabel) {
      set(`A${rn}`, r.colourLabel, { font: calibri, border: { left: T, right: T, bottom: T }, alignment: middle });
    }
    set(`B${rn}`, r.size, { font: calibri, border: { right: T, bottom: T }, alignment: middle, numFmt: '@' });
    set(`C${rn}`, String(r.qty), { font: calibri, border: { right: T, bottom: T }, alignment: middle, numFmt: '@' });
    set(`D${rn}`, r.boxes, { font: calibri, border: { right: T, bottom: T }, alignment: middle });
    set(`E${rn}`, { formula: `SUM(D${rn}*C${rn})`, result: r.pcs }, { font: calibri, border: { right: T, bottom: T }, alignment: middle });
    set(`F${rn}`, r.cartons, { font: calibri, border: { right: T, bottom: T }, alignment: middle, numFmt: '@' });
  });

  // Totals sit at row 40 like the hand-made template (the gap rows stay
  // blank), pushed down only if a delivery overflows the template area.
  const totalRowNum = Math.max(40, dataStart + rows.length + 1);
  const sumBottom = totalRowNum - 1;
  set(`A${totalRowNum}`, 'Total Boxes/Pcs.', { font: arial({ bold: true }), border: { left: T, right: T, bottom: T }, alignment: centre });
  set(`D${totalRowNum}`, { formula: `SUM(D${dataStart}:D${sumBottom})`, result: totalBoxes }, { font: arial({ bold: true, color: RED }), border: { right: T, bottom: T }, alignment: centre });
  set(`E${totalRowNum}`, { formula: `SUM(E${dataStart}:E${sumBottom})`, result: totalPcs }, { font: arial({ bold: true, color: RED }), border: { right: T, bottom: T }, alignment: centre });
  ws.getRow(totalRowNum).height = 15.75;

  const footerStart = totalRowNum + 2;
  const footer = [
    '  Email. denovosourcing@gmail.com',
    'T&C:  Please check the goods against this packing list. Any discrepancies must be notified in writing          ',
    'within 12 hours of receipt of goods. Defective goods must be returned within 7 days from the day of delivery.',
    'Ownership of the above goods does not transfer to the buyer untill the payment is received in full.',
    'No claims considered for shortage of goods collected from premises.',
    'Goods are sold subject to our Terms and Conditions of sale copies of which are available on request.',
  ];
  footer.forEach((line, i) => {
    const rn = footerStart + i;
    ws.mergeCells(`A${rn}:F${rn}`);
    set(`A${rn}`, line, { font: arial({ size: 9 }), alignment: centre });
    ws.getRow(rn).height = 12;
  });

  return wb;
}

// ── Box-sticker workbook (mirrors the web Stickers page) ─────────────────────

export function buildStickerWorkbook({ po, bookingRef, groups }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Stickers');
  const cartons = groups.flatMap((g) => g.cartons.map((c) => ({ ...c, colour: g.colour, sku: g.sku })));
  const thick = { style: 'thick', color: { argb: 'FF000000' } };
  const border = { top: thick, bottom: thick, left: thick, right: thick };
  const bold14 = { name: 'Arial', size: 11, bold: true };
  const center = { horizontal: 'center', vertical: 'middle', wrapText: true };
  [12.63, 13, 13, 17, 12.63, 13, 13].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  function sc(row, col, val, mergeSpan) {
    if (mergeSpan > 1) ws.mergeCells(row, col, row, col + mergeSpan - 1);
    const cell = ws.getCell(row, col);
    cell.value = val;
    cell.font = bold14;
    cell.alignment = center;
    cell.border = border;
    return cell;
  }

  function drawSticker(rowStart, colStart, cartonNum, totalCartons, size, qty, cartonColour, cartonSku) {
    const r = rowStart, c = colStart;
    sc(r, c, 'SUPPLIER: DENOVO SOURCING', 3);
    sc(r + 1, c, 'PO', 1); sc(r + 1, c + 1, po, 2);
    sc(r + 2, c, 'SKU', 1); sc(r + 2, c + 1, cartonSku, 2);
    sc(r + 3, c, 'Booking Ref', 1); sc(r + 3, c + 1, bookingRef ?? '', 2);
    sc(r + 4, c, 'SIZE', 1); sc(r + 4, c + 1, size, 2);
    sc(r + 5, c, 'COLOUR', 1); sc(r + 5, c + 1, cartonColour, 2);
    sc(r + 6, c, 'QTY', 1); sc(r + 6, c + 1, qty, 2);
    sc(r + 7, c, 'CARTON NO.', 1); sc(r + 7, c + 1, cartonNum, 1); sc(r + 7, c + 2, `OF ${totalCartons}`, 1);
    ws.mergeCells(r + 8, c, r + 10, c + 2);
    ws.getCell(r + 8, c).border = border;
    sc(r + 11, c, 'Customer', 1); sc(r + 11, c + 1, 'PLT', 2);
  }

  const ROWS_PER_PAGE = 29;
  const TOP_COLS = [1, 5];
  const BOT_COLS = [1, 5];
  const totalCartons = cartons.length;
  cartons.forEach(({ size, qty, colour, sku: cartonSku }, i) => {
    const page = Math.floor(i / 4), pos = i % 4, pageOffset = page * ROWS_PER_PAGE;
    const rowStart = pos < 2 ? pageOffset + 1 : pageOffset + 15;
    const colStart = pos < 2 ? TOP_COLS[pos] : BOT_COLS[pos - 2];
    drawSticker(rowStart, colStart, i + 1, totalCartons, size, qty, colour, cartonSku);
  });

  ws.pageSetup = {
    paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.35, right: 0.05, top: 0.45, bottom: 0.18, header: 0, footer: 0 },
  };
  const pages = Math.ceil(totalCartons / 4);
  for (let p = 0; p < pages; p++) {
    const o = p * ROWS_PER_PAGE;
    for (let r = 1; r <= 8; r++) ws.getRow(o + r).height = 37;
    ws.getRow(o + 9).height = 20; ws.getRow(o + 10).height = 20; ws.getRow(o + 11).height = 20;
    ws.getRow(o + 12).height = 37; ws.getRow(o + 13).height = 4; ws.getRow(o + 14).height = 4;
    for (let r = 15; r <= 22; r++) ws.getRow(o + r).height = 37;
    ws.getRow(o + 23).height = 20; ws.getRow(o + 24).height = 20; ws.getRow(o + 25).height = 20;
    ws.getRow(o + 26).height = 37; ws.getRow(o + 27).height = 1; ws.getRow(o + 28).height = 1; ws.getRow(o + 29).height = 1;
    if (p < pages - 1) {
      try {
        ws.getRow(o + ROWS_PER_PAGE).addPageBreak();
      } catch (_) {
        if (!ws.model.rowBreaks) ws.model.rowBreaks = [];
        ws.model.rowBreaks.push({ id: o + ROWS_PER_PAGE, max: 16383, min: 1, man: true });
      }
    }
  }
  return wb;
}

// ── Date helpers ─────────────────────────────────────────────────────────────

export function formatUk(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

export function addDaysUTC(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
