// Pure business rules for the PLT invoice + statement automation
// (send-plt-invoices.mjs): parsing a completed booking task into invoice
// data, the invoice PDF itself, and the edits to the shared statement sheet.
// Nothing here talks to Google or Supabase, so it is unit-testable
// (see ../tests/plt-invoice.test.mjs).
import { deflateSync } from 'node:zlib';

export const PLT_RECIPIENTS = [
  'Medius PLT Invoices UK <pltukinvoices@prettylittlething.com>',
  'Jade Wynne <jade.wynne@prettylittlething.com>',
];

// Invoices up to 273 were issued and sent by hand before this automation
// existed; they are already on the statement.
export const FIRST_AUTOMATED_INVOICE = 274;
export const PAYMENT_TERMS_DAYS = 45;
export const VAT_RATE_PERCENT = 20;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_ABBR = MONTHS.map((month) => month.slice(0, 3));

// ── Booking task → invoice data ──────────────────────────────────────────────

// Completed booking tasks look like (see draft-packing-list.mjs and
// domain.mjs addPackingSummaryToTaskNotes):
//   title: "INV 269 — Black Stretch Woven Frill Hem Shift Dress"
//   notes: 70062955 / CNO6432 / Sun 27-Sep-26 11:00 / Price (PPU): £8.00 /
//          Packed qty (total): 199 / Total boxes: 7 / EBUK22709-113
// Returns { invoice, ... } or { invoice, problem } when the task can't be
// invoiced automatically; null when it isn't an invoiced booking task.
export function parseInvoiceTask(task) {
  const title = String(task?.title ?? '').trim();
  const titleMatch = title.match(/^INV\s+(\d+)\s*[—–-]\s*(.+)$/);
  if (!titleMatch) return null;
  const invoice = Number(titleMatch[1]);
  const description = titleMatch[2].trim();
  const lines = String(task.notes ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

  const dtLine = lines.find((line) => /^\w{3}\s+\d{2}-\w{3}-\d{2}\s+\d{1,2}:\d{2}$/.test(line));
  const isoDateLine = lines.find((line) => /^\d{4}-\d{2}-\d{2}$/.test(line));
  const timeLine = lines.find((line) => /^\d{1,2}:\d{2}$/.test(line));
  const priceLine = lines.find((line) => /^Price \(PPU\):/i.test(line));
  const qtyLine = lines.find((line) => /^Packed qty \(total\):/i.test(line));
  const boxesLine = lines.find((line) => /^Total boxes:/i.test(line));
  const poLine = lines.find((line) => /^\d{6,10}$/.test(line));
  const itemLine = lines.find((line) => /^Invoice lines:/i.test(line));

  let deliveryDate = null;
  let deliveryTime = null;
  if (dtLine) {
    const m = dtLine.match(/^\w{3}\s+(\d{2})-(\w{3})-(\d{2})\s+(\d{1,2}:\d{2})$/);
    const monthIdx = MONTH_ABBR.findIndex((month) => month.toLowerCase() === m[2].toLowerCase());
    if (monthIdx !== -1) {
      deliveryDate = `20${m[3]}-${String(monthIdx + 1).padStart(2, '0')}-${m[1]}`;
      deliveryTime = m[4];
    }
  } else if (isoDateLine) {
    deliveryDate = isoDateLine;
    deliveryTime = timeLine ?? null;
  }

  const known = new Set([dtLine, isoDateLine, timeLine, priceLine, qtyLine, boxesLine, poLine, itemLine].filter(Boolean));
  // Line 2 of the notes is the SKU(s) ("CNO6432" or "CNQ1/CNQ2"); the
  // booking reference is always the last line.
  const skuLine = lines[1] && !known.has(lines[1]) && /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/i.test(lines[1]) ? lines[1] : null;
  const last = lines.at(-1);
  const bookingRef = last && !known.has(last) && last !== skuLine ? last : null;

  const ppus = priceLine ? [...priceLine.matchAll(/£\s*([\d,]+(?:\.\d+)?)/g)].map((m) => m[1].replace(/,/g, '')) : [];
  const quantity = qtyLine ? Number(qtyLine.replace(/^[^:]*:/, '').trim()) : NaN;
  const cartons = boxesLine ? Number(boxesLine.replace(/^[^:]*:/, '').trim()) : NaN;
  const po = poLine ? poLine.replace(/^0+(?=\d)/, '') : null;

  const base = { invoice, taskId: task.id, po, description, sku: skuLine, bookingRef, deliveryDate, deliveryTime };
  if (!Number.isSafeInteger(invoice) || invoice <= 0) return { ...base, problem: 'invalid invoice number' };
  if (!po) return { ...base, problem: 'no PO in the task notes' };
  if (!deliveryDate) return { ...base, problem: 'no delivery date in the task notes (no booking)' };
  if (!validDate(deliveryDate) || (deliveryTime && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(deliveryTime))) {
    return { ...base, problem: 'invalid delivery date or time' };
  }
  if (!Number.isInteger(quantity) || quantity <= 0) return { ...base, problem: 'no "Packed qty (total)" line in the task notes' };
  if (!Number.isInteger(cartons) || cartons <= 0) return { ...base, problem: 'no "Total boxes" line in the task notes' };
  if (itemLine) {
    try {
      const items = JSON.parse(itemLine.replace(/^[^:]*:/, '').trim());
      if (!Array.isArray(items) || !items.length || items.some((item) =>
        !item || typeof item.sku !== 'string' || !item.sku.trim() ||
        typeof item.description !== 'string' || !item.description.trim() ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0 ||
        !Number.isSafeInteger(item.unitPricePence) || item.unitPricePence <= 0)) {
        throw new Error('each line needs SKU, description, positive quantity and price in pence');
      }
      if (items.reduce((sum, item) => sum + item.quantity, 0) !== quantity) throw new Error('line quantities do not match packed total');
      const netPence = items.reduce((sum, item) => sum + item.quantity * item.unitPricePence, 0);
      if (!Number.isSafeInteger(netPence)) throw new Error('invoice amount is too large');
      const vatPence = Math.round(netPence * VAT_RATE_PERCENT / 100);
      return { ...base, quantity, cartons, items, netPence, vatPence, totalPence: netPence + vatPence };
    } catch (error) { return { ...base, problem: `invalid Invoice lines: ${error.message}` }; }
  }
  if (ppus.length === 0) return { ...base, problem: 'no "Price (PPU)" line in the task notes' };
  if (!skuLine) return { ...base, problem: 'no SKU in the task notes' };
  if (new Set(ppus.map(Number)).size > 1) return { ...base, problem: `more than one PPU (${priceLine}); add Invoice lines with per-SKU quantities and prices` };
  const unitPricePence = Math.round(Number(ppus[0]) * 100);
  if (!Number.isSafeInteger(unitPricePence) || unitPricePence <= 0) return { ...base, problem: 'invalid or zero PPU' };
  return { ...base, quantity, cartons, unitPricePence, ...invoiceAmounts(quantity, unitPricePence) };
}

export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

// Written when cartons are packed, while exact per-SKU quantities still exist.
export function packingInvoiceLines(groups) {
  return groups.map((group) => {
    const price = group.ppu;
    return {
      sku: group.sku, description: group.description,
      quantity: group.cartons.reduce((sum, carton) => sum + Number(carton.qty), 0),
      unitPricePence: price === null || price === undefined || String(price).trim() === '' ? null : Math.round(Number(price) * 100),
    };
  });
}

export function invoiceAmounts(quantity, unitPricePence) {
  const netPence = quantity * unitPricePence;
  const vatPence = Math.round((netPence * VAT_RATE_PERCENT) / 100);
  return { netPence, vatPence, totalPence: netPence + vatPence };
}

// The template's "Product" column: the garment type from the description.
const GARMENTS = ['Dress', 'Jumpsuit', 'Playsuit', 'Skirt', 'Top', 'Bodysuit', 'Corset', 'Shirt', 'Blouse',
  'Trousers', 'Shorts', 'Jeans', 'Leggings', 'Blazer', 'Jacket', 'Coat', 'Cardigan', 'Jumper', 'Hoodie', 'Set', 'Co-ord'];

export function productType(description) {
  let best = null;
  for (const garment of GARMENTS) {
    const re = new RegExp(`\\b${garment}s?\\b`, 'gi');
    for (const m of String(description).matchAll(re)) {
      if (!best || m.index > best.index) best = { garment, index: m.index };
    }
  }
  return best?.garment ?? 'Garment';
}

// ── Dates (Europe/London) ────────────────────────────────────────────────────

function londonOffsetMs(utcMs) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - utcMs;
}

// UTC instant for a London wall-clock date + "HH:MM" (end of day when the
// booking has no time).
export function londonInstant(isoDate, time) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const [hh, mm] = time ? time.split(':').map(Number) : [23, 59];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return new Date(guess - londonOffsetMs(guess - londonOffsetMs(guess)));
}

export function deliveryHasPassed(parsed, now = new Date()) {
  return Boolean(parsed.deliveryDate) && londonInstant(parsed.deliveryDate, parsed.deliveryTime) <= now;
}

export function londonToday(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export const longDate = (isoDate) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
export const dashDate = (isoDate) => isoDate.split('-').reverse().join('-');

export const money = (pence) => (pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const invoiceLabel = (invoice) => String(invoice).padStart(4, '0');
export const invoiceFilename = (inv) => `Invoice_${invoiceLabel(inv.invoice)}_PO_${inv.po}.pdf`;

// ── Invoice PDF ──────────────────────────────────────────────────────────────
// Reproduces the existing invoice template (Invoice_0269_PO_70062955.pdf)
// with the same A4 page, standard fonts, coordinates and rules. Hand-written
// PDF rather than a library: the layout is fixed text + three rules, and the
// standard 14 fonts need no embedding.

// Helvetica advance widths (1/1000 em) for WinAnsi 32..126.
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const WIN_ANSI_EXTRAS = { '£': 0xa3, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '€': 0x80 };

function winAnsiCode(char) {
  if (WIN_ANSI_EXTRAS[char] !== undefined) return WIN_ANSI_EXTRAS[char];
  const code = char.codePointAt(0);
  if ((code >= 32 && code <= 126) || (code >= 0xa0 && code <= 0xff)) return code;
  return 63; // '?'
}

export function helveticaWidth(text, size) {
  let units = 0;
  for (const char of String(text)) {
    const code = winAnsiCode(char);
    units += code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32] : 556;
  }
  return (units * size) / 1000;
}

function pdfString(text) {
  let out = '(';
  for (const char of String(text)) {
    const code = winAnsiCode(char);
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${String.fromCharCode(code)}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

function wrapText(text, size, maxWidth) {
  const lines = [];
  let current = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && helveticaWidth(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

const pdfNumber = (value) => String(Math.round(value * 1000) / 1000);

function pdfDate(date) {
  const offset = londonOffsetMs(date.getTime());
  const local = new Date(date.getTime() + offset);
  const pad = (n) => String(n).padStart(2, '0');
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset) / 60000;
  return `D:${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}` +
    `${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}'${pad(abs % 60)}'`;
}

export function buildInvoicePdf(inv, { invoiceDate, createdAt = new Date() }) {
  const ops = [];
  const BLACK = '0 0 0 rg';
  const GREY = '.721569 .721569 .721569 rg';
  const text = (font, size, x, y, value) =>
    ops.push(`BT /${font} ${size} Tf 1 0 0 1 ${pdfNumber(x)} ${pdfNumber(y)} Tm ${pdfString(value)} Tj ET`);
  const right = (font, size, rightEdge, y, value) => text(font, size, rightEdge - helveticaWidth(value, size), y, value);
  const rule = (width, x1, x2, y) => ops.push(`${width} w`, `n ${x1} ${pdfNumber(y)} m ${x2} ${pdfNumber(y)} l S`);

  ops.push(BLACK);
  text('F2', 22, 42, 793, 'Denovo Sourcing LTD');
  ['61-63 Bardolph Street,', 'Leicester', 'England', 'LE4 6EH'].forEach((line, i) => text('F1', 9.5, 42, 772 - i * 10.5, line));

  ops.push(GREY);
  text('F1', 8.5, 59, 703, 'To:');
  ops.push(BLACK);
  ['Prettylittlething.com Limited', 'Wellington Mill', 'Pollard Street East', 'Manchester', 'M40 7FS']
    .forEach((line, i) => text('F1', 10, 59, 692 - i * 11, line));

  text('F3', 22, 357, 692, 'Invoice');
  text('F1', 8.5, 357, 671, 'Number:');
  text('F1', 10, 357, 660, invoiceLabel(inv.invoice));
  text('F1', 8.5, 357, 639, 'Date:');
  text('F1', 10, 357, 628, longDate(invoiceDate));
  text('F1', 8.5, 357, 607, 'Your reference/order number:');
  text('F1', 10, 357, 596, inv.po);

  ops.push(GREY);
  text('F1', 8.5, 59, 574, 'Delivery address:');
  ops.push(BLACK);
  ['PrettyLittleThing.com', '615 Shepcote Lane', 'Tinsley', 'Sheffield', 'S9 1RF']
    .forEach((line, i) => text('F1', 10, 59, 563 - i * 11, line));

  text('F1', 10, 42, 482, `${inv.cartons} ${inv.cartons === 1 ? 'Carton' : 'Cartons'} sent via Jacks`);

  ops.push('.933333 .933333 .933333 rg', 'n 42 450 511 15 re f*', BLACK);
  text('F1', 9.5, 45, 454.5, 'Product');
  text('F1', 9.5, 119, 454.5, 'Quantity');
  text('F1', 9.5, 160, 454.5, 'Description');
  right('F1', 9.5, 494, 454.5, 'Price');
  right('F1', 9.5, 550, 454.5, '£');

  let itemY = 430;
  const items = inv.items ?? [{ sku: inv.sku, description: inv.description, quantity: inv.quantity, unitPricePence: inv.unitPricePence }];
  for (const [index, item] of items.entries()) {
    const price = money(item.unitPricePence);
    const descriptionLines = wrapText([item.sku, item.description].filter(Boolean).join(' '), 9.5,
      494 - helveticaWidth(price, 9.5) - 12 - 160);
    text('F1', 9.5, 45, itemY, productType(item.description));
    text('F1', 9.5, 119, itemY, String(item.quantity));
    descriptionLines.forEach((line, i) => text('F1', 9.5, 160, itemY - i * 11.4, line));
    right('F1', 9.5, 494, itemY, price);
    right('F1', 9.5, 550, itemY, money(item.quantity * item.unitPricePence));
    itemY -= (descriptionLines.length - 1) * 11.4 + (index < items.length - 1 ? 25 : 0);
  }
  const shift = 430 - itemY;
  if (260 - shift < 42) throw new Error(`INV ${inv.invoice}: too many invoice lines for the A4 template; issue manually`);
  rule('.8', 496, 553, 393 - shift);
  right('F1', 9.5, 550, 384 - shift, money(inv.netPence));
  text('F1', 9.5, 160, 366 - shift, `VAT at ${VAT_RATE_PERCENT}%`);
  right('F1', 9.5, 550, 366 - shift, money(inv.vatPence));
  text('F4', 9.5, 160, 348 - shift, 'Total');
  rule('.8', 496, 553, 356 - shift);
  right('F4', 9.5, 550, 348 - shift, money(inv.totalPence));
  rule('1.6', 496, 553, 340 - shift);

  text('F1', 10, 42, 302 - shift, `Terms: ${PAYMENT_TERMS_DAYS} days from invoice date`);
  if (inv.bookingRef) text('F1', 10, 42, 281 - shift, `Booking Ref : ${inv.bookingRef}`);
  text('F1', 10, 42, (inv.bookingRef ? 260 : 281) - shift, 'VAT registration number: GB 439179559');

  const content = deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
  const title = `Invoice ${invoiceLabel(inv.invoice)} - PO ${inv.po}`;
  const created = pdfDate(createdAt);
  const objects = [
    '<< /F1 2 0 R /F2 3 0 R /F3 4 0 R /F4 5 0 R >>',
    '<< /BaseFont /Helvetica /Encoding /WinAnsiEncoding /Name /F1 /Subtype /Type1 /Type /Font >>',
    '<< /BaseFont /Times-Roman /Encoding /WinAnsiEncoding /Name /F2 /Subtype /Type1 /Type /Font >>',
    '<< /BaseFont /Times-Italic /Encoding /WinAnsiEncoding /Name /F3 /Subtype /Type1 /Type /Font >>',
    '<< /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding /Name /F4 /Subtype /Type1 /Type /Font >>',
    '<< /Contents 10 0 R /MediaBox [ 0 0 595.2756 841.8898 ] /Parent 9 0 R /Resources << /Font 1 0 R /ProcSet [ /PDF /Text ] >> /Rotate 0 /Type /Page >>',
    '<< /PageMode /UseNone /Pages 9 0 R /Type /Catalog >>',
    `<< /Author (Denovo Sourcing LTD) /CreationDate (${created}) /ModDate (${created}) /Producer (Denovo Orders) /Title ${pdfString(title)} >>`,
    '<< /Count 1 /Kids [ 6 0 R ] /Type /Pages >>',
    null, // content stream, appended as binary below
  ];

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = chunks[0].length;
  const offsets = [];
  const push = (buffer) => { chunks.push(buffer); length += buffer.length; };
  objects.forEach((body, i) => {
    offsets.push(length);
    if (body === null) {
      push(Buffer.from(`${i + 1} 0 obj\n<< /Filter /FlateDecode /Length ${content.length} >>\nstream\n`, 'latin1'));
      push(content);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1'));
    }
  });
  const xrefOffset = length;
  push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Info 8 0 R /Root 7 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    'latin1',
  ));
  return Buffer.concat(chunks);
}

// ── Statement sheet ──────────────────────────────────────────────────────────
// The "PLT Statement" sheet (A:F invoice table, H:I summary) groups rows
// into sections that each end in a "Subtotal — ..." row; new invoices go at
// the end of "Not Yet Due". The plan is computed from the sheet's current
// cells so it works whether totals are formulas or typed values, and every
// subtotal/summary cell is rewritten as a formula over the rows it covers.

const cellText = (value) => String(value ?? '').trim();

export function statementInvoiceNumbers(grid) {
  return new Set(grid.map((row) => cellText(row?.[0]).replace(/^0+(?=\d)/, '')).filter((value) => /^\d+$/.test(value)));
}

// Sheets serial day number (1899-12-30 epoch) for a yyyy-mm-dd date.
const sheetSerial = (isoDate) => Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);

export function planStatementUpdate(grid, invoices, { today }) {
  const rows = grid.map((row) => [...(row ?? [])]);
  const headerIdx = rows.findIndex((row) => /^invoice\s*no/i.test(cellText(row[0])));
  const insertAt = rows.findIndex((row) => /^subtotal/i.test(cellText(row[0])) && /not yet due/i.test(cellText(row[0])));
  if (headerIdx === -1) throw new Error('statement: no "Invoice No" header row found in column A');
  if (insertAt === -1) throw new Error('statement: no "Subtotal — Not Yet Due" row found in column A');

  // New rows copy the value types (number vs text, date serial vs text) of
  // the last invoice row so they display with the same formatting.
  const template = rows.slice(headerIdx + 1, insertAt).reverse().find((row) => /^\d+$/.test(cellText(row[0])));
  const formatSourceIndex = template ? rows.indexOf(template) : undefined;
  const stripeStart = rows.slice(headerIdx + 1, insertAt).filter(row => cellText(row[0]) && typeof row[3] === 'number' && !/^subtotal/i.test(cellText(row[0]))).length;
  const ukDate = isoDate => isoDate.split('-').reverse().join('/');
  const asDate = (isoDate) => (typeof template?.[1] === 'number' ? sheetSerial(isoDate) : ukDate(isoDate));
  const asDue = (isoDate) => (typeof template?.[4] === 'number' ? sheetSerial(isoDate) : ukDate(isoDate));
  const asInvoice = (invoice) => (typeof template?.[0] === 'number' ? invoice : String(invoice));
  const asPo = (po) => (typeof template?.[2] === 'number' ? Number(po) : String(po));

  const newRows = invoices.map((inv) => [
    asInvoice(inv.invoice),
    asDate(inv.invoiceDate),
    asPo(inv.po),
    inv.totalPence / 100,
    asDue(addDays(inv.invoiceDate, PAYMENT_TERMS_DAYS)),
    'UPCOMING',
  ]);
  rows.splice(insertAt, 0, ...newRows);

  const updates = newRows.map((values, i) => ({ range: `A${insertAt + i + 1}:F${insertAt + i + 1}`, values: [values], raw: true }));

  // Subtotals: SUM of the rows since the previous section boundary.
  const subtotals = [];
  let sectionStart = headerIdx + 1;
  rows.forEach((row, idx) => {
    if (idx <= headerIdx || !/^subtotal/i.test(cellText(row[0]))) return;
    const paid = rows.slice(sectionStart, idx).some((item) => /^(paid|settled)$/i.test(cellText(item[5])));
    const formula = idx <= sectionStart ? '=0' : paid
      ? `=SUMIFS(D${sectionStart + 1}:D${idx},F${sectionStart + 1}:F${idx},"<>PAID",F${sectionStart + 1}:F${idx},"<>SETTLED")`
      : `=SUM(D${sectionStart + 1}:D${idx})`;
    updates.push({ range: `D${idx + 1}`, values: [[formula]] });
    subtotals.push({ label: cellText(row[0]), cell: `D${idx + 1}` });
    sectionStart = idx + 1;
  });
  const sumOf = (cells) => (cells.length ? `=${cells.join('+')}` : '=0');
  const totalIdx = rows.findIndex((row) => /^total outstanding/i.test(cellText(row[0])));
  const totalCell = totalIdx === -1 ? null : `D${totalIdx + 1}`;
  if (totalCell) updates.push({ range: totalCell, values: [[sumOf(subtotals.map((s) => s.cell))]] });

  // Summary block: label in column H, amount in column I.
  const buckets = {
    overdue: subtotals.filter((s) => /overdue/i.test(s.label)).map((s) => s.cell),
    'due soon': subtotals.filter((s) => /due soon/i.test(s.label)).map((s) => s.cell),
    'not yet due': subtotals.filter((s) => /not yet due/i.test(s.label)).map((s) => s.cell),
  };
  rows.forEach((row, idx) => {
    const label = cellText(row[7]).toLowerCase();
    if (buckets[label]) updates.push({ range: `I${idx + 1}`, values: [[sumOf(buckets[label])]] });
    else if (label === 'total outstanding' && totalCell) updates.push({ range: `I${idx + 1}`, values: [[`=${totalCell}`]] });
  });

  const dateIdx = rows.findIndex((row) => /^statement date:/i.test(cellText(row[0])));
  if (dateIdx !== -1) updates.push({ range: `A${dateIdx + 1}`, values: [[`Statement Date: ${longDate(today)}`]], raw: true });

  return { insertAt, count: newRows.length, updates, formatSourceIndex, stripeStart };
}

export function statementRowMatches(grid, inv) {
  const matches = grid.filter((row) => cellText(row[0]).replace(/^0+(?=\d)/, '') === String(inv.invoice));
  if (matches.length !== 1) throw new Error(`INV ${inv.invoice}: expected one statement row, found ${matches.length}`);
  const row = matches[0];
  if (cellText(row[2]).replace(/^0+(?=\d)/, '') !== inv.po || Math.round(Number(row[3]) * 100) !== inv.totalPence ||
    statementDueDate(row[1]) !== inv.invoiceDate || statementDueDate(row[4]) !== addDays(inv.invoiceDate, PAYMENT_TERMS_DAYS)) {
    throw new Error(`INV ${inv.invoice}: existing statement PO, amount or dates differ from saved invoice`);
  }
  return true;
}

function statementDueDate(value) {
  if (typeof value === 'number') return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  const text = cellText(value);
  if (validDate(text)) return text;
  const parts = text.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  const iso = parts ? `${parts[3]}-${parts[2]}-${parts[1]}` : null;
  return validDate(iso) ? iso : null;
}

export function remittanceFriday(dueDate) {
  const weekday = new Date(`${dueDate}T00:00:00Z`).getUTCDay();
  return addDays(dueDate, (5 - weekday + 7) % 7);
}

export function fridayOfWeek(today) {
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(today, 4 - weekday);
}

// Whole-row moves preserve the statement's formatting, notes and credit rows.
// Only unpaid numeric invoices with dated terms are aged; immediate credits
// stay in their existing section. All moves and formula changes are atomic.
export function planStatementAgeing(grid, { today, sheetId }) {
  const rows = grid.map((row) => [...row]);
  const requests = [];
  const changes = [];
  const bucket = (label) => /immediate/i.test(label) ? 'immediate' : /overdue/i.test(label) ? 'overdue' : /due soon/i.test(label) ? 'due soon' : /not yet due/i.test(label) ? 'not yet due' : null;
  const invoices = rows.filter((row) => /^\d+$/.test(cellText(row[0])) && !/^(paid|settled)$/i.test(cellText(row[5])));
  for (const invoiceRow of invoices) {
    let idx = rows.indexOf(invoiceRow);
    const due = statementDueDate(invoiceRow[4]);
    if (!due) {
      if (/^immediate$/i.test(cellText(invoiceRow[4]))) continue;
      throw new Error(`Statement invoice ${invoiceRow[0]} has an invalid payment due date`);
    }
    const paymentFriday = remittanceFriday(due);
    const wanted = paymentFriday < today ? 'overdue' : paymentFriday <= fridayOfWeek(today) ? 'due soon' : 'not yet due';
    const boundary = rows.slice(idx + 1).find((row) => /^subtotal/i.test(cellText(row[0])));
    if (!boundary) throw new Error(`Statement invoice ${invoiceRow[0]} has no section subtotal`);
    if (bucket(cellText(boundary[0])) !== wanted) {
      const target = rows.findIndex((row) => /^subtotal/i.test(cellText(row[0])) && bucket(cellText(row[0])) === wanted);
      if (target < 0) throw new Error(`Statement has no ${wanted} subtotal section`);
      requests.push({ moveDimension: { source: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 }, destinationIndex: target } });
      rows.splice(idx, 1);
      rows.splice(target > idx ? target - 1 : target, 0, invoiceRow);
    }
    idx = rows.indexOf(invoiceRow);
    invoiceRow[5] = wanted === 'overdue' ? 'OVERDUE' : wanted === 'due soon' ? 'DUE' : 'UPCOMING';
    changes.push(invoiceRow);
  }
  // Due-specific headings become stale as rows age into those sections.
  const updates = rows.flatMap((row, idx) => /^subtotal.*overdue/i.test(cellText(row[0])) && !/immediate/i.test(cellText(row[0]))
    ? [{ range: `A${idx + 1}`, values: [['Subtotal — Overdue']], raw: true }] : []);
  for (const row of changes) updates.push({ range: `F${rows.indexOf(row) + 1}`, values: [[row[5]]], raw: true });
  updates.push(...planStatementUpdate(rows, [], { today }).updates);
  return { requests, updates, rows };
}

export function draftSubject(invoiceNumbers) {
  const sorted = [...invoiceNumbers].sort((a, b) => a - b);
  if (sorted.length === 1) return `Invoice ${sorted[0]} and Statement`;
  const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
  const list = contiguous ? `${sorted[0]}-${sorted.at(-1)}` : sorted.join(', ');
  return `Invoices ${list} and Statement`;
}

export function draftBody(count) {
  return `Hi,\nPlease find ${count === 1 ? 'invoice' : 'invoices'} and statement attached below.\nThanks\n`;
}
