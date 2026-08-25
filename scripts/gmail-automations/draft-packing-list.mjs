// Turns WhatsApp photos of handwritten docket sheets into an approved ISC
// Portal handoff, closing the last manual gap in the order pipeline. The human
// forwards the packer's photo(s) to
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
//   with the number, create the Portal handoff manifest and confirm with a
//   reply. The Portal automation submits the cartons, then replies with the
//   official Portal packing list and validated BEL label PDF attached.
//
// Phase A embeds its extraction as a JSON block in its own reply, so Phase B
// never re-reads the photos — the human's reply implicitly approves the
// numbers shown in that email.
//
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
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
} from './lib/google.mjs';
import { extractJson } from './lib/claude.mjs';
import { callPackingListDb } from './lib/automation-db.mjs';
import { getExecution, completeExecution } from './lib/execution-state.mjs';
import { buildPortalManifest } from './lib/portal-manifest.mjs';
import {
  DATA_MARKER,
  validateDocket,
  formatUk,
  addDaysUTC,
  findBooking,
  extractInvoiceNumber,
} from './lib/domain.mjs';

// Sonnet, not the Haiku default: misreading a handwritten digit changes a
// carton quantity silently, which the checksums below can't always catch
// (two errors can cancel out), so the stronger vision model is worth it.
const VISION_MODEL = 'claude-sonnet-5';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// The Claude API rejects images over 8000px on a side or 10 MB encoded, and
// full-resolution phone photos forwarded by email hit both (issue #24). The
// model downsamples to ~1568px on the long edge anyway, so shrinking to that
// bound loses nothing while guaranteeing both limits.
const MAX_IMAGE_EDGE = 1568;

async function prepareImage(buffer) {
  const resized = await sharp(buffer)
    .rotate() // bake in EXIF orientation before re-encoding strips it
    .resize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { mediaType: 'image/jpeg', data: resized.toString('base64') };
}

const SYSTEM_PROMPT = `You extract packing data from photos of printed "DOCKET SHEET" pages with handwritten quantities, for Denovo Apparel's order tracker.

Each photo shows one docket sheet: a printed header table (DOCKET SHEET #<number>, DATE, EX-FACTORY DATE, PO NUMBER, STYLE NO., SKU, DESCRIPTION, SUPPLIER, FABRICATION) and a printed size row (e.g. 4 6 8 10 12 14 16) with ordered quantities underneath. The packers then HANDWRITE the actual packed quantities, usually below the printed table, in columns aligned under each size:
- Each handwritten number in a size's column is the quantity in ONE box/carton. Two stacked numbers under size 8 (e.g. 20 and 15) mean two cartons: one of 20, one of 15.
- A column's numbers are often summed with an underline: the figure UNDER the line is the column total, NOT another carton — never include column totals as cartons. A size's column often repeats the printed size number at the top; that is a size label, not a quantity.
- A quantity written with a lowercase "s" immediately before the number (e.g. "s15") marks that carton as a SMALL box (half-height BDCM3 carton); an unmarked number is a normal box (BDCM1). The "s" is a letter, clearly distinct in shape from the digit "5" — don't confuse the two, and don't infer "small" from the quantity being low, only from an actual written "s".
- Somewhere on the page there is usually a handwritten grand total (e.g. "153 TOTAL") and a box count (e.g. "10 Box"). If any cartons are marked small, there is often also a handwritten small-box count (e.g. "2 small").
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
      "cartons": [ { "size": "4", "qty": 9, "small": false }, { "size": "8", "qty": 20, "small": false }, { "size": "8", "qty": 15, "small": true } ],
      "written_total": 153,
      "written_boxes": 10,
      "written_small_boxes": 1,
      "unreadable": false,
      "problem": null
    }
  ]
}

Rules:
- One entry per docket sheet photographed, in the order the photos appear.
- "po" must be a 10-digit zero-padded numeric string (left-pad what's printed).
- "cartons" lists every handwritten carton quantity, sizes in the printed column order, boxes within a size top-to-bottom. Sizes are strings exactly as printed (they can be "S"/"M" or "16"/"18"). "small" is true only when that specific number has a written "s" prefix, false otherwise — always include it.
- "written_total" / "written_boxes" are the handwritten grand total and box count; use null for one that genuinely is not on the page.
- "written_small_boxes" is the handwritten count of small-box cartons, if the packer wrote one (e.g. "2 small"); use null if no such count appears on the page, even if some cartons are marked small.
- If a page is too blurry or ambiguous to read confidently, set "unreadable": true and say why in "problem" — never guess a digit you cannot actually read.`;

// ── Phase A: read photos, extract, ask for the INV number ───────────────────

async function processNewThread(ctx, thread) {
  const { accessToken, apiKey, database, labels } = ctx;
  const replyCheckpoint = await getExecution(database, 'draft-packing-list', thread.id, 'invoice-request-sent');
  if (replyCheckpoint?.status === 'completed') {
    await modifyThreadLabels(accessToken, thread.id, { add: [labels.awaitingInv] });
    return { outcome: 'awaiting_inv', recovered: true };
  }
  const full = await getThread(accessToken, thread.id);
  if (full.messages.some((message) => extractPlainTextBody(message).includes(DATA_MARKER))) {
    await completeExecution(database, 'draft-packing-list', thread.id, 'invoice-request-sent', {
      recovered_from_gmail: true,
    });
    await modifyThreadLabels(accessToken, thread.id, { add: [labels.awaitingInv] });
    return { outcome: 'awaiting_inv', recovered: true };
  }

  const images = [];
  for (const message of full.messages) {
    for (const att of listAttachments(message)) {
      if (IMAGE_TYPES.has(att.mimeType)) {
        const buffer = await getAttachment(accessToken, message.id, att.attachmentId);
        try {
          images.push(await prepareImage(buffer));
        } catch (err) {
          // A corrupt attachment won't fix itself on retry — hand it to a human.
          console.error(`  undecodable ${att.mimeType} attachment on thread ${thread.id}: ${err.message}`);
          await modifyThreadLabels(accessToken, thread.id, { add: [labels.needsReview] });
          return { outcome: 'needs_review', reason: 'undecodable photo attachment' };
        }
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
  let orders;
  try {
    ({ orders } = await database('orders-for-po', { po }));
  } catch (error) {
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
    : 'No booking found yet — a dispatch date is required before the Portal packing list can be completed.';

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
      `Reply to this email with the invoice number (e.g. "220") and the Portal handoff will be prepared within the hour.\n\n` +
      `${DATA_MARKER}\n${JSON.stringify(payload)}`,
  });
  await completeExecution(database, 'draft-packing-list', thread.id, 'invoice-request-sent', { po });
  await modifyThreadLabels(accessToken, thread.id, { add: [labels.awaitingInv] });
  return { outcome: 'awaiting_inv' };
}

// ── Phase B: pick up the INV number and create the Portal handoff ────────────

async function processAwaitingThread(ctx, thread) {
  const { accessToken, database, labels } = ctx;
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

  const poDisplay = payload.po.replace(/^0+/, '');
  const groups = payload.groups.map((g) => ({
    colour: (g.colour ?? '').toUpperCase(), sku: g.sku, cartons: g.cartons,
  }));
  const dispatchDate = payload.booking?.date ? addDaysUTC(payload.booking.date, -1) : null;
  if (!dispatchDate) {
    await modifyThreadLabels(accessToken, thread.id, {
      add: [labels.needsReview],
      remove: [labels.awaitingInv],
    });
    return { outcome: 'needs_review', reason: 'no booking date available for the dispatch date' };
  }
  const handoffBytes = Buffer.from(JSON.stringify({
    po: payload.po,
    invoiceId: invoice,
    dispatchDate,
    groups,
  }));

  if (process.env.PORTAL_HANDOFF_DIR) {
    const manifest = buildPortalManifest({
      po: payload.po,
      gmailThreadId: thread.id,
      invoiceId: invoice,
      dispatchDate,
      groups,
      workbookBytes: handoffBytes,
      sourceRevision: process.env.GITHUB_SHA ?? 'local',
    });
    await mkdir(process.env.PORTAL_HANDOFF_DIR, { recursive: true });
    await writeFile(
      join(process.env.PORTAL_HANDOFF_DIR, `${manifest.po}-${manifest.idempotencyKey.slice(0, 12)}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx' },
    ).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }

  const confirmationStep = `portal-handoff-confirmation-sent:${invoice}`;
  const confirmation = await getExecution(database, 'draft-packing-list', thread.id, confirmationStep);
  if (confirmation?.status !== 'completed') {
    const latest = replyMessage ?? full.messages[full.messages.length - 1];
    const cartonCount = groups.reduce((total, group) => total + group.cartons.length, 0);
    console.log(`  Portal handoff ready for PO ${poDisplay}: ${cartonCount} cartons.`);
    await sendReply(accessToken, {
      threadId: thread.id,
      replyTo: latest,
      to: getHeader(latest, 'From'),
      subject: getHeader(latest, 'Subject') || 'Portal packing list',
      body:
        `Portal handoff prepared for PO ${poDisplay}: ${cartonCount} cartons.\n\n` +
        `The official ISC Portal packing list and validated BEL label PDF will be attached to this thread after Portal submission completes.`,
    });
    await completeExecution(database, 'draft-packing-list', thread.id, confirmationStep, {
      po: payload.po,
      carton_count: cartonCount,
    });
  }
  await modifyThreadLabels(accessToken, thread.id, {
    add: [labels.processed],
    remove: [labels.awaitingInv],
  });
  return { outcome: 'created', name: `Portal handoff for PO ${poDisplay}` };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const accessToken = await getAccessToken({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
  });
  // 'Packing List' itself is hand-applied by the human when forwarding a
  // photo; the sub-labels are pure script bookkeeping, created on demand.
  const labels = {
    packingList: await getOrCreateLabel(accessToken, 'Packing List'),
    awaitingInv: await getOrCreateLabel(accessToken, 'Packing List/Awaiting INV'),
    processed: await getOrCreateLabel(accessToken, 'Packing List/Processed'),
    needsReview: await getOrCreateLabel(accessToken, 'Packing List/Needs Review'),
  };

  const ctx = {
    accessToken,
    apiKey: process.env.ANTHROPIC_API_KEY,
    database: callPackingListDb,
    labels,
    openTasks: null,
  };

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
  console.log(`  Portal handoffs created: ${created}`);
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
