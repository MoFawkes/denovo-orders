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
        colourLabel: i === 0 ? group.colour : i === 1 ? group.sku : '',
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
    { width: 20 }, { width: 34 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 },
  ];

  const bold = { bold: true };
  ws.getCell('C1').value = 'PACKING LIST';
  ws.getCell('C1').font = { bold: true, size: 14 };

  const headerFields = [
    ['Customer:', 'Pretty Little Thing', 'Delivery Note No.', String(invoice)],
    ['Delivery Address :', 'Shepcote Lane, Sheffield S9 1RF', 'Dispatch Date', dispatchDate ?? ''],
    ['', '', 'Delivery Date', deliveryDate ?? ''],
    ['SUPPLIER:', 'DENOVO SOURCING', 'Booking Ref.', bookingRef ?? ''],
    ['', '25 Temple Building, Temple Road', '', ''],
    ['', 'Leicester', '', ''],
    ['', 'LE5 4JG', '', ''],
    ['PO Reference', poDisplay, '', ''],
    ['Internal Code', internalCode, '', ''],
    ['Description', description, '', ''],
  ];
  headerFields.forEach(([a, b, e, f], i) => {
    const row = ws.getRow(2 + i);
    if (a) { row.getCell(1).value = a; row.getCell(1).font = bold; }
    if (b) row.getCell(2).value = b;
    if (e) { row.getCell(5).value = e; row.getCell(5).font = bold; }
    if (f) row.getCell(6).value = f;
  });

  const border = {
    top: { style: 'thin' }, bottom: { style: 'thin' },
    left: { style: 'thin' }, right: { style: 'thin' },
  };
  const tableHeaderRow = 12;
  const headers = ['Colour Breakdown', 'Size', 'Qty per Box', 'No of Boxes', 'Total Pcs', 'Carton Nos.'];
  headers.forEach((h, i) => {
    const cell = ws.getRow(tableHeaderRow).getCell(1 + i);
    cell.value = h;
    cell.font = bold;
    cell.border = border;
    cell.alignment = { horizontal: 'center' };
  });

  const { rows, totalBoxes, totalPcs } = cartonRows(groups);
  rows.forEach((r, i) => {
    const row = ws.getRow(tableHeaderRow + 1 + i);
    const values = [r.colourLabel, r.size, r.qty, r.boxes, r.pcs, r.cartons];
    values.forEach((v, j) => {
      const cell = row.getCell(1 + j);
      cell.value = v;
      cell.border = border;
      if (j > 0) cell.alignment = { horizontal: 'center' };
    });
  });

  const totalRow = ws.getRow(tableHeaderRow + 1 + rows.length);
  totalRow.getCell(1).value = 'Total Boxes/Pcs.';
  totalRow.getCell(1).font = bold;
  totalRow.getCell(4).value = totalBoxes;
  totalRow.getCell(5).value = totalPcs;
  for (let c = 1; c <= 6; c++) {
    totalRow.getCell(c).border = border;
    if (c > 1) totalRow.getCell(c).alignment = { horizontal: 'center' };
    if (c === 4 || c === 5) totalRow.getCell(c).font = bold;
  }

  const footerStart = totalRow.number + 2;
  const footer = [
    'Email. denovosourcing@gmail.com',
    'T&C: Please check the goods against this packing list. Any discrepancies must be notified in writing ',
    'within 12 hours of receipt of goods. Defective goods must be returned within 7 days from the day of delivery.',
    'Ownership of the above goods does not transfer to the buyer untill the payment is received in full.',
    'No claims considered for shortage of goods collected from premises.',
    'Goods are sold subject to our Terms and Conditions of sale copies of which are available on request.',
  ];
  footer.forEach((line, i) => {
    ws.getRow(footerStart + i).getCell(1).value = line;
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

// Booking Google Tasks (created by mark-order-booked.mjs) carry newline-
// separated notes: padded PO, style_no (optional), ISO delivery date, time,
// booking ref. Recognise the lines by shape rather than position so an
// absent style_no doesn't shift everything.
export function parseBookingTask(task) {
  const lines = (task.notes ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const date = lines.find((l) => /^\d{4}-\d{2}-\d{2}$/.test(l)) ?? null;
  const time = lines.find((l) => /^\d{1,2}:\d{2}$/.test(l)) ?? null;
  const last = lines[lines.length - 1];
  const ref = lines.length > 1 && last !== lines[0] &&
    !/^\d{4}-\d{2}-\d{2}$/.test(last) && !/^\d{1,2}:\d{2}$/.test(last)
    ? last
    : null;
  return { date, time, ref };
}

function findBooking(openTasks, po, styleNo) {
  const task = openTasks.find(
    (t) => t.notes?.includes(po) && (!styleNo || t.notes.includes(styleNo)),
  );
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
// "inv no 220" etc, ignoring quoted lines from earlier messages.
export function extractInvoiceNumber(text) {
  const fresh = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('>'))
    .join('\n')
    // Everything below a quote header ("On ... wrote:") is quoted content.
    .split(/^On .+wrote:/m)[0];
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

  // Find the newest automation-data message we sent, then look for a later
  // human reply carrying the invoice number.
  let dataMessage = null;
  let payload = null;
  for (const message of full.messages) {
    const body = extractPlainTextBody(message);
    const idx = body.indexOf(DATA_MARKER);
    if (idx !== -1) {
      const match = body.slice(idx + DATA_MARKER.length).match(/\{[\s\S]*\}/);
      if (match) {
        try {
          payload = JSON.parse(match[0]);
          dataMessage = message;
        } catch {
          // fall through: a corrupted block in an older message may be
          // superseded by a later, intact one.
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

  const dataIndex = full.messages.indexOf(dataMessage);
  let invoice = null;
  let replyMessage = null;
  for (const message of full.messages.slice(dataIndex + 1)) {
    const body = extractPlainTextBody(message);
    if (body.includes(DATA_MARKER)) continue; // our own follow-up
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
}

// Guarded so importing the builders (e.g. from a test) doesn't start a run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
