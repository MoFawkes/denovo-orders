// Watches denovogb@gmail.com's Google Drive for packing lists (spreadsheets
// titled "INV <n> ...") and closes the loop on Booked orders: when a packing
// list's PO Reference + Internal Code (SKU) match an order in stage Booked,
// the order is marked Completed with the packing list's Google Sheet link and
// invoice number, and the booking's Google Task gets "INV <n>" added to its
// title and is ticked off, so it shows struck through (goods dispatched)
// instead of lingering as an open to-do.
//
// Matching is deliberately strict — PO and SKU both, read from inside the
// spreadsheet (filenames repeat across rebuys and carry no PO). A packing
// list whose PO/SKU matches no Booked order is left alone and retried next
// run (it may simply not be booked yet); files already linked to any order
// are skipped permanently.
//
// Requires the denovogb refresh token to carry the drive.readonly scope --
// re-run oauth-setup.mjs (which now requests it) if this fails with 403.
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import {
  getAccessToken,
  driveListFiles,
  driveDownloadFile,
  listOpenTasks,
  patchTask,
} from './lib/google.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://sfwnmddlmiprvsoxbatz.supabase.co';

// Only look at recently modified files: everything older has either been
// linked already or predates the tracker. Wide enough to survive the
// automation being broken for a while without missing dispatches.
const LOOKBACK_DAYS = 60;

function normalisePo(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? digits.padStart(10, '0') : null;
}

// Walks the sheet and pulls the labelled fields regardless of exact layout:
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

async function main() {
  const accessToken = await getAccessToken({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
  });
  const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: bookedOrders, error: bookedError } = await supabase
    .from('orders')
    .select('id, po, style, style_no, description, stage')
    .eq('stage', 'Booked');
  if (bookedError) throw new Error(`fetching Booked orders failed: ${bookedError.message}`);

  console.log(`Booked orders awaiting dispatch: ${bookedOrders.length}.`);
  if (bookedOrders.length === 0) {
    console.log('Nothing to match against — done.');
    return;
  }

  // Every file id already referenced by any order's packing_list_url is
  // done — never re-process, whatever stage that order is in now.
  const { data: linkedRows, error: linkedError } = await supabase
    .from('orders')
    .select('packing_list_url')
    .neq('packing_list_url', '');
  if (linkedError) throw new Error(`fetching linked packing lists failed: ${linkedError.message}`);
  const linkedIds = new Set(
    (linkedRows ?? [])
      .map((r) => r.packing_list_url?.match(/\/d\/([A-Za-z0-9_-]{20,})/)?.[1])
      .filter(Boolean),
  );

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  let files;
  try {
    files = await driveListFiles(
      accessToken,
      `name contains 'INV' and mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ` +
        `and modifiedTime > '${since}' and trashed = false`,
    );
  } catch (err) {
    if (String(err.message).includes('403')) {
      throw new Error(
        'Drive listing failed with 403 — the GMAIL_OAUTH_REFRESH_TOKEN secret probably lacks the ' +
          'drive.readonly scope. Re-run scripts/gmail-automations/oauth-setup.mjs as denovogb@gmail.com ' +
          `and update the secret. Original error: ${err.message}`,
      );
    }
    throw err;
  }

  const candidates = files.filter((f) => /\bINV\b/i.test(f.name) && !linkedIds.has(f.id));
  console.log(`Packing lists found: ${files.length} (${candidates.length} not yet linked to an order).`);

  // Fetched lazily on first use: only needed when something actually matches.
  let openTasks = null;

  let completed = 0;
  let tasksUpdated = 0;
  let unmatched = 0;
  let parseFailures = 0;

  for (const file of candidates) {
    let fields;
    try {
      const buffer = await driveDownloadFile(accessToken, file.id);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      fields = extractPackingListFields(workbook.worksheets[0]);
    } catch (err) {
      console.error(`  ${file.name}: could not read/parse (${err.message}) — will retry next run.`);
      parseFailures++;
      continue;
    }

    const po = normalisePo(fields.po);
    const sku = (fields.sku ?? '').trim().toUpperCase();
    const invoice = (fields.invoice ?? '').trim();
    if (!po || !sku) {
      console.log(`  ${file.name}: no PO/SKU inside — skipping.`);
      unmatched++;
      continue;
    }

    const matches = bookedOrders.filter(
      (o) => o.po === po && (o.style ?? '').trim().toUpperCase() === sku,
    );
    if (matches.length === 0) {
      unmatched++;
      continue;
    }

    const link = `https://docs.google.com/spreadsheets/d/${file.id}/edit?usp=sharing`;
    const ids = matches.map((o) => o.id);
    const { error: updateError } = await supabase
      .from('orders')
      .update({ stage: 'Completed', packing_list_url: link, invoice_no: invoice })
      .in('id', ids);
    if (updateError) {
      console.error(`  ${file.name}: order update failed (${updateError.message}) — will retry next run.`);
      parseFailures++;
      continue;
    }

    const { error: eventError } = await supabase.from('order_events').insert(
      matches.map((o) => ({
        order_id: o.id,
        old_stage: 'Booked',
        new_stage: 'Completed',
        changed_by: null,
      })),
    );
    if (eventError) console.error(`  order_events insert error: ${eventError.message}`);

    completed += matches.length;
    console.log(`  ${file.name}: PO ${po} / ${sku} -> Completed (INV ${invoice}), packing list linked.`);

    // Stamp the booking's Google Task with the invoice number and tick it
    // off. The task was created by mark-order-booked with the PO and SKU(s)
    // in its notes; a missing task is not an error (it may have been ticked
    // off already).
    //
    // PO is matched against both the padded (DB) and unpadded (as shown in
    // notes since the combined-task format change) forms, since tasks
    // created before that change still carry the padded PO. Those legacy
    // notes also carry no SKU at all (and current ones carry SKUs, never
    // style_no), so the SKU is a preference, not a requirement: prefer a
    // PO-matching task that also names the SKU or style_no, but accept a
    // lone PO match rather than never stamping a legacy task.
    try {
      if (openTasks === null) openTasks = await listOpenTasks(accessToken);
      for (const order of matches) {
        const poUnpadded = order.po.replace(/^0+(?=\d)/, '');
        const poMatches = openTasks.filter(
          (t) =>
            (t.notes?.includes(order.po) || t.notes?.includes(poUnpadded)) &&
            !t.title?.includes(`INV ${invoice}`),
        );
        const task =
          poMatches.find((t) => order.style && t.notes.includes(order.style)) ??
          poMatches.find((t) => order.style_no && t.notes.includes(order.style_no)) ??
          (poMatches.length === 1 ? poMatches[0] : undefined);
        if (task) {
          task.title = `INV ${invoice} — ${task.title}`;
          await patchTask(accessToken, task.id, { title: task.title, status: 'completed' });
          tasksUpdated++;
        }
      }
    } catch (err) {
      console.error(`  task update failed for PO ${po}: ${err.message}`);
    }
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Orders marked Completed: ${completed}`);
  console.log(`  Google Tasks stamped with INV number: ${tasksUpdated}`);
  console.log(`  Packing lists with no matching Booked order (left for next run): ${unmatched}`);
  console.log(`  Failed to read/update (left for retry next run): ${parseFailures}`);
}

// Guarded so importing extractPackingListFields (e.g. from a test) doesn't
// kick off a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
