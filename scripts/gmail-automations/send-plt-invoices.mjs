// Invoices PrettyLittleThing for delivered orders. Once an order's booking
// Google Task (denovogb) has been completed with its "INV <n> — ..." title by
// draft-packing-list.mjs AND the booked delivery time has passed, this
// script, hourly from .github/workflows/gmail-automations.yml:
//
//   1. builds the invoice PDF (same layout as the hand-made invoices, e.g.
//      Invoice_0269_PO_70062955.pdf) from the task's PO, SKU, description,
//      PPU, packed quantity, box count and booking reference;
//   2. adds the invoice to the shared "PLT Statement" Google Sheet under
//      Not Yet Due and recalculates its subtotals, summary and date;
//   3. saves ONE Gmail draft in denovosourcing@gmail.com, addressed to PLT's
//      invoice inbox and Jade Wynne, with every new invoice PDF plus the
//      statement PDF attached. Drafts are reviewed and sent by hand.
//
// Checkpoints (automation_executions, automation "plt-invoice", source =
// invoice number) make each step happen once: "statement-row" after the
// sheet row is written, "draft-created" after the draft is saved. An
// invoice that is already on the statement without a statement-row
// checkpoint was issued by hand and is skipped.
import { pathToFileURL } from 'node:url';
import {
  getAccessToken,
  listCompletedTasks,
  sheetsGetSheetId,
  sheetsGetValues,
  sheetsInsertRows,
  sheetsUpdateValues,
  driveExportFile,
  createDraft,
} from './lib/google.mjs';
import { callPackingListDb } from './lib/automation-db.mjs';
import { getExecution, completeExecution } from './lib/execution-state.mjs';
import {
  PLT_RECIPIENTS,
  FIRST_AUTOMATED_INVOICE,
  parseInvoiceTask,
  deliveryHasPassed,
  londonToday,
  dashDate,
  money,
  buildInvoicePdf,
  invoiceFilename,
  statementInvoiceNumbers,
  planStatementUpdate,
  draftSubject,
  draftBody,
} from './lib/plt-invoice.mjs';

const AUTOMATION = 'plt-invoice';
const STATEMENT_SPREADSHEET_ID =
  process.env.PLT_STATEMENT_SPREADSHEET_ID || '1DK9ht3fSXRopjnkZyufVPVsZaKB1jqnOndVWeYHMOy4';
const STATEMENT_SHEET = process.env.PLT_STATEMENT_SHEET || 'PLT Statement';
const LOOKBACK_DAYS = 120;

async function main() {
  if (process.env.PLT_INVOICES_ENABLED !== '1') {
    console.log('PLT invoicing is disabled (set the PLT_INVOICES_ENABLED repository variable to 1).');
    return;
  }
  const firstInvoice = Number(process.env.PLT_FIRST_INVOICE || FIRST_AUTOMATED_INVOICE);
  const now = new Date();
  const today = londonToday(now);
  const database = callPackingListDb;

  const tasksToken = await getAccessToken({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
  });
  const sourcingToken = await getAccessToken({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_SOURCING_OAUTH_REFRESH_TOKEN,
  });

  const completedMin = new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString();
  const byInvoice = new Map();
  let problems = 0;
  for (const task of await listCompletedTasks(tasksToken, { completedMin })) {
    const parsed = parseInvoiceTask(task);
    if (!parsed || parsed.invoice < firstInvoice) continue;
    const existing = byInvoice.get(parsed.invoice);
    if (existing && existing.po !== parsed.po) {
      existing.problem = `invoice number is on two booking tasks (PO ${existing.po} and PO ${parsed.po})`;
      continue;
    }
    if (!existing) byInvoice.set(parsed.invoice, parsed);
  }

  if (byInvoice.size === 0) {
    console.log(`No completed booking tasks from INV ${firstInvoice} onward.`);
    return;
  }
  const sheetId = await sheetsGetSheetId(sourcingToken, STATEMENT_SPREADSHEET_ID, STATEMENT_SHEET);
  const grid = await sheetsGetValues(sourcingToken, STATEMENT_SPREADSHEET_ID, `'${STATEMENT_SHEET}'!A1:I1000`);
  const onStatement = statementInvoiceNumbers(grid);

  const ready = [];
  for (const inv of [...byInvoice.values()].sort((a, b) => a.invoice - b.invoice)) {
    if (inv.problem) {
      // Resolved by hand once the invoice is on the statement.
      if (onStatement.has(String(inv.invoice))) continue;
      problems++;
      console.error(`INV ${inv.invoice} (PO ${inv.po ?? '?'}) cannot be invoiced automatically: ${inv.problem}. Issue it by hand and add it to the statement.`);
      continue;
    }
    if (!deliveryHasPassed(inv, now)) {
      console.log(`INV ${inv.invoice} (PO ${inv.po}): waiting for delivery ${dashDate(inv.deliveryDate)} ${inv.deliveryTime ?? ''}`.trim());
      continue;
    }
    const drafted = await getExecution(database, AUTOMATION, String(inv.invoice), 'draft-created');
    if (drafted?.status === 'completed') continue;
    ready.push(inv);
  }
  console.log(`Invoices ready to draft: ${ready.length}.`);
  if (ready.length === 0) {
    if (problems > 0) process.exitCode = 1;
    return;
  }

  // Statement: add rows for invoices not on it yet.
  const toDraft = [];
  const toAdd = [];
  for (const inv of ready) {
    const rowCheckpoint = await getExecution(database, AUTOMATION, String(inv.invoice), 'statement-row');
    if (rowCheckpoint?.status === 'completed') {
      toDraft.push({ ...inv, invoiceDate: rowCheckpoint.result?.invoice_date ?? today });
    } else if (onStatement.has(String(inv.invoice))) {
      console.log(`INV ${inv.invoice} is already on the statement but was not added by this automation; treating it as issued by hand.`);
      await completeExecution(database, AUTOMATION, String(inv.invoice), 'draft-created', { skipped: 'already on statement' });
    } else {
      toAdd.push({ ...inv, invoiceDate: today });
    }
  }

  if (toAdd.length > 0) {
    const plan = planStatementUpdate(grid, toAdd, { today });
    await sheetsInsertRows(sourcingToken, STATEMENT_SPREADSHEET_ID, sheetId, plan.insertAt, plan.count);
    const qualify = ({ range, values }) => ({ range: `'${STATEMENT_SHEET}'!${range}`, values });
    await sheetsUpdateValues(sourcingToken, STATEMENT_SPREADSHEET_ID, plan.updates.filter((u) => u.raw).map(qualify), 'RAW');
    await sheetsUpdateValues(sourcingToken, STATEMENT_SPREADSHEET_ID, plan.updates.filter((u) => !u.raw).map(qualify), 'USER_ENTERED');
    for (const inv of toAdd) {
      await completeExecution(database, AUTOMATION, String(inv.invoice), 'statement-row', {
        invoice_date: inv.invoiceDate, po: inv.po, total_pence: inv.totalPence,
      });
      console.log(`INV ${inv.invoice} (PO ${inv.po}) added to the statement: £${money(inv.totalPence)}.`);
    }
    toDraft.push(...toAdd);
  }

  if (toDraft.length === 0) {
    if (problems > 0) process.exitCode = 1;
    return;
  }
  toDraft.sort((a, b) => a.invoice - b.invoice);

  const attachments = toDraft.map((inv) => ({
    filename: invoiceFilename(inv),
    mimeType: 'application/pdf',
    buffer: buildInvoicePdf(inv, { invoiceDate: inv.invoiceDate, createdAt: now }),
  }));
  attachments.push({
    filename: `PLT_Statement_Denovo_Sourcing_${dashDate(today)}.pdf`,
    mimeType: 'application/pdf',
    buffer: await driveExportFile(sourcingToken, STATEMENT_SPREADSHEET_ID, 'application/pdf'),
  });

  const draft = await createDraft(sourcingToken, {
    to: PLT_RECIPIENTS,
    subject: draftSubject(toDraft.map((inv) => inv.invoice)),
    body: draftBody(toDraft.length),
    attachments,
  });
  for (const inv of toDraft) {
    await completeExecution(database, AUTOMATION, String(inv.invoice), 'draft-created', { draft_id: draft.id });
  }
  console.log(`Draft saved in denovosourcing@gmail.com for invoice(s) ${toDraft.map((inv) => inv.invoice).join(', ')}.`);
  if (problems > 0) process.exitCode = 1;
}

// Guarded so importing this file (e.g. from a test) doesn't start a run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
