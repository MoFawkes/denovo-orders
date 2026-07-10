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
import ExcelJS from 'exceljs';
import {
  getAccessToken,
  driveListFiles,
  driveDownloadFile,
  listOpenTasks,
  patchTask,
} from './lib/google.mjs';
import { normalisePo, extractPackingListFields, findBookingTask } from './lib/domain.mjs';
import { callPackingListDb } from './lib/automation-db.mjs';
import { completeExecution, failExecution } from './lib/execution-state.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';

// Only look at recently modified files: everything older has either been
// linked already or predates the tracker. Wide enough to survive the
// automation being broken for a while without missing dispatches.
const LOOKBACK_DAYS = 60;

async function main() {
  const accessToken = await getAccessToken({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
  });
  const database = callPackingListDb;
  const snapshot = await database('snapshot');
  const bookedOrders = snapshot.booked ?? [];

  console.log(`Booked orders awaiting dispatch: ${bookedOrders.length}.`);
  if (bookedOrders.length === 0) {
    console.log('Nothing to match against — done.');
    return;
  }

  // Every file id already referenced by any order's packing_list_url is
  // done — never re-process, whatever stage that order is in now.
  const linkedIds = new Set(snapshot.linkedFileIds ?? []);

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
      await failExecution(database, 'complete-order-from-packing-list', file.id, 'parse', err);
      console.error(`  ${file.name}: could not read/parse (${err.message}) — will retry next run.`);
      parseFailures++;
      continue;
    }
    await completeExecution(database, 'complete-order-from-packing-list', file.id, 'parse', {
      file_name: file.name,
    });

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

    let completedOrders = matches;
    if (DRY_RUN) {
      console.log(`[dry-run] complete orders: ${JSON.stringify({ fileId: file.id, po, sku, invoice })}`);
      console.log(`[dry-run] insert ${matches.length} order_events row(s)`);
    } else {
      try {
        const result = await database('complete', { fileId: file.id, po, sku, invoice });
        completedOrders = result.orders ?? [];
      } catch (error) {
        console.error(`  ${file.name}: order update failed (${error.message}) — will retry next run.`);
        parseFailures++;
        continue;
      }
      if (completedOrders.length === 0) {
        unmatched++;
        continue;
      }
    }

    completed += completedOrders.length;
    console.log(`  ${file.name}: PO ${po} / ${sku} -> Completed (INV ${invoice}), packing list linked.`);

    // Stamp the booking's Google Task with the invoice number and tick it
    // off (matching rules live in findBookingTask). The task was created by
    // mark-order-booked with the PO and SKU(s) in its notes; a missing task
    // is not an error (it may have been ticked off already).
    try {
      if (openTasks === null) openTasks = await listOpenTasks(accessToken);
      for (const order of completedOrders) {
        const task = findBookingTask(openTasks, order, invoice);
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

  // Retrying is automatic, but a persistent corrupt workbook or database
  // error must make the Actions run visible as failed.
  if (parseFailures > 0) process.exitCode = 1;
}

// Guarded so importing the module (e.g. from a test) doesn't kick off a
// live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
