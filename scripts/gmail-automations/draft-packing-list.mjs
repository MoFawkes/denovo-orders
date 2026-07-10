// Turns WhatsApp photos of handwritten docket sheets into "INV <n> ..."
// packing lists in denovogb's Google Drive, closing the last manual gap in
// the order pipeline. The human forwards the packer's photo(s) to
// denovogb@gmail.com and labels the thread 'Packing List'; this script then
// runs a two-phase, reply-driven flow (hourly, from
// .github/workflows/gmail-automations.yml):
//
//   Phase A — new threads: read the photo(s) with Claude vision (each
//   stacked handwritten number under a size column is one carton; the
//   docket's written grand total and box count act as checksums), match the
//   order in Supabase by PO + SKU, pull the confirmed delivery slot and
//   booking ref from the booking's Google Task (created by
//   mark-order-booked.mjs), then REPLY to the email showing everything that
//   was extracted and asking for the invoice number. The invoice number
//   lives in the human's separate accounts app, so it stays a human input.
//
//   Phase B — threads awaiting an INV number: when the human has replied
//   with the number, build the packing-list workbook (same layout as the
//   hand-made ones), upload it to Drive, and confirm with a reply. The
//   hourly complete-order-from-packing-list.mjs job then finds the sheet
//   and completes the Booked order exactly as it does for hand-made lists.
//
// Phase A embeds its extraction as a JSON block in its own reply, so Phase B
// never re-reads the photos — the human's reply implicitly approves the
// numbers shown in that email.
//
// Requires the drive.file scope on the denovogb refresh token (upload); see
// oauth-setup.mjs — tokens issued before that scope was added need a re-run.
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import {
  getAccessToken,
  searchThreads,
  getThread,
  modifyThreadLabels,
  listAttachments,
  getAttachment,
  getOrCreateLabel,
  getHeader,
  extractPlainTextBody,
  sendReply,
  listOpenTasks,
  driveUploadFile,
} from './lib/google.mjs';
import { extractJson } from './lib/claude.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://sfwnmddlmiprvsoxbatz.supabase.co';

// Sonnet, not the Haiku default: misreading a handwritten digit changes a
// carton quantity silently, which the checksums below can't always catch
// (two errors can cancel out), so the stronger vision model is worth it.
const VISION_MODEL = 'claude-sonnet-5';

// Marks the machine-readable block Phase A embeds in its own reply.
const DATA_MARKER = '----- automation data v1 (do not edit below this line) -----';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const SYSTEM_PROMPT = `You extract packing data from photos of printed "DOCKET SHEET" pages with handwritten quantities, for Denovo Apparel's order tracker.

Each photo shows one docket sheet: a printed header table (DOCKET SHEET #<number>, DATE, EX-FACTORY DATE, PO NUMBER, STYLE NO., SKU, DESCRIPTION, SUPPLIER, FABRICATION) and a printed size row (e.g. 4 6 8 10 12 14 16) with ordered quantities underneath. The packers then HANDWRITE the actual packed quantities, usually below the printed table, in columns aligned under each size:
- Each handwritten number in a size's column is the quantity in ONE box/carton. Two stacked numbers under size 8 (e.g. 20 and 15) mean two cartons: one of 20, one of 15.
- A column's numbers are often summed with an underline: the figure UNDER the line is the column total, NOT another carton — never include column totals as cartons. A size's column often repeats the printed size number at the top; that is a size label, not a quantity.
- Somewhere on the page there is usually a handwritten grand total (e.g. "153 TOTAL") and a box count (e.g. "10 Box").
- The SKU field often reads "<COLOUR>: <CODE>" (e.g. "SAGE: CNQ9238") — the colour word and the buyer SKU code.

Reply with ONLY a JSON object, no other text, matching this shape:
{
  "dockets": [
    {
      "docket_no": "242",
      "po": "0070054294",
      "style_no": "CNO4843",
      "sku": "CNQ9238",
      "colour": "SAGE",
      "cartons": [ { "size": "4", "qty": 9 }, { "size": "8", "qty": 20 }, { "size": "8", "qty": 15 } ],
      "written_total": 153,
      "written_boxes": 10,
      "unreadable": false,
      "problem": null
    }
  ]
}

Rules:
- One entry per docket sheet photographed, in the order the photos appear.
- "po" must be a 10-digit zero-padded numeric string (left-pad what's printed).
- "cartons" lists every handwritten carton quantity, sizes in the printed column order, boxes within a size top-to-bottom. Sizes are strings exactly as printed (they can be "S"/"M" or "16"/"18").
- "written_total" / "written_boxes" are the handwritten grand total and box count; use null for one that genuinely is not on the page.
- If a page is too blurry or ambiguous to read confidently, set "unreadable": true and say why in "problem" — never guess a digit you cannot actually read.`;

// ── Extraction validation ────────────────────────────────────────────────────

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

// ── Packing-list workbook (mirrors the hand-made "INV <n> ..." sheets) ──────
// Layout copied from the existing sheets in denovogb's Drive; the labelled
// field rows (PO Reference / Internal Code / Delivery Note No.) are what
// complete-order-from-packing-list.mjs's extractPackingListFields matches on,
// so their label-then-value-in-next-cell shape must not change.

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
  // is what complete-order-from-packing-list.mjs matches on, do not change.
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

// ── Shared helpers ───────────────────────────────────────────────────────────

function formatUk(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

function addDaysUTC(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

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

function findBooking(openTasks, po, styleNo) {
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

// ── Phase A: read photos, extract, ask for the INV number ───────────────────

async function processNewThread(ctx, thread) {
  const { accessToken, apiKey, supabase, labels } = ctx;
  const full = await getThread(accessToken, thread.id);

  const images = [];
  for (const message of full.messages) {
    for (const att of listAttachments(message)) {
      if (IMAGE_TYPES.has(att.mimeType)) {
        const buffer = await getAttachment(accessToken, message.id, att.attachmentId);
        images.push({ mediaType: att.mimeType, data: buffer.toString('base64') });
      }
    }
  }
  if (images.length === 0) {
    await modifyThreadLabels(accessToken, thread.id, { add: [labels.needsReview] });
    return { outcome: 'needs_review', reason: 'no photo attachments' };
  }

  let result;
  try {
    result = await extractJson({
      apiKey,
      model: VISION_MODEL,
      system: SYSTEM_PROMPT,
      prompt: `These ${images.length} photo(s) are docket sheets from one delivery. Extract the packing data.`,
      images,
      maxTokens: 4096,
    });
  } catch (err) {
    console.error(`  vision extraction failed for thread ${thread.id}: ${err.message}`);
    // API failure is not a judgment — leave unlabeled so it retries next run.
    return { outcome: 'failed' };
  }

  const latest = full.messages[full.messages.length - 1];
  const replyCtx = {
    threadId: thread.id,
    replyTo: latest,
    to: getHeader(latest, 'From'),
    subject: getHeader(latest, 'Subject') || 'Packing list',
  };

  const dockets = result.dockets ?? [];
  const problems = [];
  for (const d of dockets) {
    const problem = validateDocket(d);
    if (problem) problems.push(`docket #${d.docket_no ?? '?'}: ${problem}`);
  }
  if (dockets.length === 0) problems.push('no docket sheets recognised in the photo(s)');
  const uniquePos = [...new Set(dockets.map((d) => d.po))];
  if (uniquePos.length > 1) {
    problems.push(`photos span ${uniquePos.length} different POs — send one PO per email`);
  }

  if (problems.length > 0) {
    await sendReply(accessToken, {
      ...replyCtx,
      body:
        `Could not draft a packing list from this email:\n\n- ${problems.join('\n- ')}\n\n` +
        `Fix the issue and forward the photo(s) again in a new email (this thread is now marked Needs Review).`,
    });
    await modifyThreadLabels(accessToken, thread.id, { add: [labels.needsReview] });
    return { outcome: 'needs_review', reason: problems.join('; ') };
  }

  const po = uniquePos[0];
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, po, style, style_no, description, stage')
    .eq('po', po);
  if (error) {
    console.error(`  order lookup failed for PO ${po}: ${error.message}`);
    return { outcome: 'failed' };
  }

  const orderByGroup = [];
  for (const d of dockets) {
    const order = (orders ?? []).find(
      (o) => (o.style ?? '').trim().toUpperCase() === d.sku.trim().toUpperCase(),
    );
    if (!order) {
      await sendReply(accessToken, {
        ...replyCtx,
        body:
          `Could not draft a packing list: no order in the tracker matches PO ${po} with SKU ${d.sku} ` +
          `(docket #${d.docket_no}). This thread is marked Needs Review.`,
      });
      await modifyThreadLabels(accessToken, thread.id, { add: [labels.needsReview] });
      return { outcome: 'needs_review', reason: `no order for PO ${po} / ${d.sku}` };
    }
    orderByGroup.push(order);
  }

  let booking = null;
  try {
    if (ctx.openTasks === null) ctx.openTasks = await listOpenTasks(accessToken);
    booking = findBooking(ctx.openTasks, po, orderByGroup[0].style_no);
  } catch (err) {
    console.error(`  booking task lookup failed: ${err.message}`);
  }

  const summary = dockets
    .map((d, i) => {
      const perSize = new Map();
      for (const c of d.cartons) {
        if (!perSize.has(c.size)) perSize.set(c.size, []);
        perSize.get(c.size).push(c.qty);
      }
      const sizes = [...perSize.entries()]
        .map(([size, qtys]) => `  size ${size}: ${qtys.join(' + ')} = ${qtys.reduce((a, b) => a + b, 0)}`)
        .join('\n');
      return (
        `Docket #${d.docket_no} — ${orderByGroup[i].description} (${d.sku})\n${sizes}\n` +
        `  total ${d.written_total} pcs in ${d.cartons.length} boxes`
      );
    })
    .join('\n\n');

  const bookingLine = booking?.date
    ? `Delivery ${formatUk(booking.date)}${booking.time ? ` ${booking.time}` : ''}` +
      `${booking.ref ? `, booking ref ${booking.ref}` : ''}, dispatch ${formatUk(addDaysUTC(booking.date, -1))}.`
    : 'No booking found yet — the date/booking ref fields will be left blank (edit the sheet in Drive later, or reply once it is booked).';

  const payload = {
    po,
    groups: dockets.map((d, i) => ({
      colour: d.colour ?? '',
      sku: d.sku,
      cartons: d.cartons,
      description: orderByGroup[i].description,
      style_no: orderByGroup[i].style_no,
    })),
    booking,
  };

  await sendReply(accessToken, {
    ...replyCtx,
    body:
      `Read from the docket photo(s) — PO ${po.replace(/^0+/, '')}:\n\n${summary}\n\n${bookingLine}\n\n` +
      `Reply to this email with the invoice number (e.g. "220") and the packing list will be created in Drive within the hour.\n\n` +
      `${DATA_MARKER}\n${JSON.stringify(payload)}`,
  });
  await modifyThreadLabels(accessToken, thread.id, { add: [labels.awaitingInv] });
  return { outcome: 'awaiting_inv' };
}

// ── Phase B: pick up the INV number, build + upload the sheet ────────────────

async function processAwaitingThread(ctx, thread) {
  const { accessToken, labels } = ctx;
  const full = await getThread(accessToken, thread.id);

  // Find the automation-data message we sent, then look for a later human
  // reply carrying the invoice number. Take the FIRST message containing a
  // valid data block, not the last: Phase A sends exactly one such message
  // per thread (its label leaves the "new threads" search the moment it
  // succeeds, so it never runs twice), but every human reply quotes it back
  // in full -- meaning the marker shows up again in every later message too.
  // Taking the last occurrence would latch onto the human's own most recent
  // reply and leave nothing after it to scan.
  let dataMessage = null;
  let payload = null;
  for (const message of full.messages) {
    if (dataMessage) break;
    const body = extractPlainTextBody(message);
    const idx = body.indexOf(DATA_MARKER);
    if (idx !== -1) {
      const match = body.slice(idx + DATA_MARKER.length).match(/\{[\s\S]*\}/);
      if (match) {
        try {
          payload = JSON.parse(match[0]);
          dataMessage = message;
        } catch {
          // corrupted marker -- shouldn't happen since Phase A always writes
          // valid JSON, but keep scanning defensively rather than giving up.
        }
      }
    }
  }
  if (!payload) {
    console.error(`  thread ${thread.id} is Awaiting INV but has no readable data block — flagging.`);
    await modifyThreadLabels(accessToken, thread.id, {
      add: [labels.needsReview],
      remove: [labels.awaitingInv],
    });
    return { outcome: 'needs_review', reason: 'missing data block' };
  }

  // Every human reply quotes dataMessage back in full, so its body also
  // contains DATA_MARKER -- that's expected, not a sign this is one of our
  // own messages (Phase A never sends a second one; see above). Don't skip
  // on that basis: extractInvoiceNumber already cuts the quoted portion off
  // before searching for the number.
  const dataIndex = full.messages.indexOf(dataMessage);
  let invoice = null;
  let replyMessage = null;
  for (const message of full.messages.slice(dataIndex + 1)) {
    const body = extractPlainTextBody(message);
    const found = extractInvoiceNumber(body);
    if (found) {
      invoice = found;
      replyMessage = message;
    }
  }
  if (!invoice) return { outcome: 'still_awaiting' }; // human hasn't replied yet

  const internalCode = payload.groups.map((g) => g.sku).join('/');
  const description = combineDescriptions(payload.groups, payload.groups);
  const booking = payload.booking;
  const workbook = buildPackingListWorkbook({
    invoice,
    dispatchDate: booking?.date ? formatUk(addDaysUTC(booking.date, -1)) : '',
    deliveryDate: booking?.date ? formatUk(booking.date) : '',
    bookingRef: booking?.ref ?? '',
    poDisplay: payload.po.replace(/^0+/, ''),
    internalCode,
    description,
    groups: payload.groups.map((g) => ({ colour: (g.colour ?? '').toUpperCase(), sku: g.sku, cartons: g.cartons })),
  });

  const name = `INV ${invoice} ${description}.xlsx`;
  let uploaded;
  try {
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    uploaded = await driveUploadFile(accessToken, {
      name,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer,
    });
  } catch (err) {
    console.error(`  Drive upload failed for ${name}: ${err.message} — will retry next run.`);
    if (String(err.message).includes('403')) {
      console.error(
        '  A 403 here usually means the GMAIL_OAUTH_REFRESH_TOKEN secret lacks the drive.file scope — ' +
          're-run scripts/gmail-automations/oauth-setup.mjs as denovogb@gmail.com and update the secret.',
      );
    }
    return { outcome: 'failed' };
  }

  const latest = replyMessage ?? full.messages[full.messages.length - 1];
  await sendReply(accessToken, {
    threadId: thread.id,
    replyTo: latest,
    to: getHeader(latest, 'From'),
    subject: getHeader(latest, 'Subject') || 'Packing list',
    body:
      `Created "${name}" in Drive: https://drive.google.com/file/d/${uploaded.id}/view\n\n` +
      `The order will be marked Completed automatically once the hourly packing-list job matches it (the order must be in stage Booked).`,
  });
  await modifyThreadLabels(accessToken, thread.id, {
    add: [labels.processed],
    remove: [labels.awaitingInv],
  });
  return { outcome: 'created', name };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const accessToken = await getAccessToken({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
  });
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // 'Packing List' itself is hand-applied by the human when forwarding a
  // photo; the sub-labels are pure script bookkeeping, created on demand.
  const labels = {
    packingList: await getOrCreateLabel(accessToken, 'Packing List'),
    awaitingInv: await getOrCreateLabel(accessToken, 'Packing List/Awaiting INV'),
    processed: await getOrCreateLabel(accessToken, 'Packing List/Processed'),
    needsReview: await getOrCreateLabel(accessToken, 'Packing List/Needs Review'),
  };

  const ctx = { accessToken, apiKey: process.env.ANTHROPIC_API_KEY, supabase, labels, openTasks: null };

  const newThreads = await searchThreads(
    accessToken,
    'label:Packing-List -label:Packing-List-Awaiting-INV -label:Packing-List-Processed -label:Packing-List-Needs-Review',
  );
  console.log(`New Packing List thread(s): ${newThreads.length}.`);
  let asked = 0;
  let flagged = 0;
  let failed = 0;
  for (const thread of newThreads) {
    console.log(`Processing new thread ${thread.id}...`);
    const result = await processNewThread(ctx, thread);
    if (result.outcome === 'awaiting_inv') asked++;
    else if (result.outcome === 'needs_review') { flagged++; console.log(`  -> Needs Review: ${result.reason}`); }
    else failed++;
  }

  const awaitingThreads = await searchThreads(
    accessToken,
    'label:Packing-List-Awaiting-INV -label:Packing-List-Processed',
  );
  console.log(`Thread(s) awaiting an INV number: ${awaitingThreads.length}.`);
  let created = 0;
  let stillAwaiting = 0;
  for (const thread of awaitingThreads) {
    console.log(`Checking awaiting thread ${thread.id}...`);
    const result = await processAwaitingThread(ctx, thread);
    if (result.outcome === 'created') { created++; console.log(`  -> ${result.name}`); }
    else if (result.outcome === 'still_awaiting') stillAwaiting++;
    else if (result.outcome === 'needs_review') flagged++;
    else failed++;
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Extracted + asked for INV number: ${asked}`);
  console.log(`  Packing lists created in Drive: ${created}`);
  console.log(`  Still awaiting a reply with the INV number: ${stillAwaiting}`);
  console.log(`  Flagged Needs Review: ${flagged}`);
  console.log(`  Failed (left for retry next run): ${failed}`);

  // A failed thread still retries next run, but exit non-zero so the Actions
  // run turns red instead of green — otherwise a persistent failure (e.g. a
  // Drive-upload 403 from a refresh token missing the drive.file scope) is
  // invisible unless someone opens the run log.
  if (failed > 0) process.exitCode = 1;
}

// Guarded so importing the builders (e.g. from a test) doesn't start a run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
