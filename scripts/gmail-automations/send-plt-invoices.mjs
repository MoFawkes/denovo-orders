// Hourly PLT drafts. The booked delivery time is the user's chosen trigger;
// it does not confirm physical delivery. Nothing sends emails.
import { pathToFileURL } from 'node:url';
import {
  getAccessToken, listCompletedTasks, sheetsGetSheetId, sheetsGetValues,
  sheetsApplyPlan, driveExportFile, createDraft, searchMessages, getMessage,
} from './lib/google.mjs';
import { callPackingListDb } from './lib/automation-db.mjs';
import { getExecution } from './lib/execution-state.mjs';
import {
  PLT_RECIPIENTS, FIRST_AUTOMATED_INVOICE, parseInvoiceTask, deliveryHasPassed,
  londonToday, dashDate, buildInvoicePdf, invoiceFilename, statementInvoiceNumbers,
  planStatementAgeing, draftSubject, draftBody,
} from './lib/plt-invoice.mjs';
import { ensureInvoiceStatement, ensureInvoiceDraft } from './lib/invoice-delivery.mjs';

const STATEMENT_SPREADSHEET_ID = process.env.PLT_STATEMENT_SPREADSHEET_ID || '1DK9ht3fSXRopjnkZyufVPVsZaKB1jqnOndVWeYHMOy4';
const STATEMENT_SHEET = process.env.PLT_STATEMENT_SHEET || 'PLT Statement';

async function main() {
  if (process.env.PLT_INVOICES_ENABLED !== '1') {
    console.log('PLT invoicing is disabled (set PLT_INVOICES_ENABLED to 1).');
    return;
  }
  const firstInvoice = Number(process.env.PLT_FIRST_INVOICE || FIRST_AUTOMATED_INVOICE);
  if (!Number.isSafeInteger(firstInvoice) || firstInvoice < 1) {
    throw new Error('PLT_FIRST_INVOICE must be a positive integer');
  }
  const now = new Date();
  const today = londonToday(now);
  const database = callPackingListDb;
  const tasksToken = await getAccessToken({ clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET, refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const sourcingToken = await getAccessToken({ clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET, refreshToken: process.env.GMAIL_SOURCING_OAUTH_REFRESH_TOKEN });
  const sheetId = await sheetsGetSheetId(sourcingToken, STATEMENT_SPREADSHEET_ID, STATEMENT_SHEET);
  const range = "'" + STATEMENT_SHEET.replaceAll("'", "''") + "'!A:I";
  const readGrid = () => sheetsGetValues(sourcingToken, STATEMENT_SPREADSHEET_ID, range);
  const writePlan = (plan) => sheetsApplyPlan(sourcingToken, STATEMENT_SPREADSHEET_ID, sheetId, plan);
  const grid = await readGrid();
  // Age the statement even when there are no new invoices.
  await writePlan(planStatementAgeing(grid, { today, sheetId }));
  const onStatement = statementInvoiceNumbers(grid);
  const byInvoice = new Map();
  // Never let old unissued invoices fall out of a rolling lookback window.
  for (const task of await listCompletedTasks(tasksToken)) {
    const parsed = parseInvoiceTask(task);
    if (!parsed || parsed.invoice < firstInvoice) continue;
    const existing = byInvoice.get(parsed.invoice);
    if (existing) {
      const comparable = (inv) => JSON.stringify({ ...inv, taskId: undefined,
        ...(inv.items ? { description: undefined, sku: undefined } : {}) });
      if (comparable(existing) !== comparable(parsed)) {
        existing.problem = 'booking tasks with this invoice have conflicting data';
        existing.conflict = true;
      }
    } else byInvoice.set(parsed.invoice, parsed);
  }
  const ready = [];
  let problems = 0;
  for (const parsed of [...byInvoice.values()].sort((a, b) => a.invoice - b.invoice)) {
    const source = String(parsed.invoice);
    const done = await getExecution(database, 'plt-invoice', source, 'draft-created');
    if (done?.status === 'completed') continue;
    const prepared = await getExecution(database, 'plt-invoice', source, 'prepared');
    const inv = prepared?.status === 'completed' && !parsed.conflict ? prepared.result.invoice : parsed;
    if (!inv) throw new Error(`INV ${source}: invalid saved invoice record`);
    if (inv.problem) {
      if (onStatement.has(String(inv.invoice)) && prepared?.status !== 'completed') continue;
      console.error(`INV ${inv.invoice}: ${inv.problem}. Correct the completed task notes or issue manually.`);
      problems++;
      continue;
    }
    if (!deliveryHasPassed(inv, now)) {
      console.log(`INV ${inv.invoice}: waiting for booked delivery ${dashDate(inv.deliveryDate)} ${inv.deliveryTime ?? ''}`);
      continue;
    }
    try {
      const prepared = await ensureInvoiceStatement({ database, inv, today, readGrid, writePlan,
        validatePdf: (data) => buildInvoicePdf(data, { invoiceDate: data.invoiceDate, createdAt: now }) });
      if (prepared) ready.push(prepared);
    } catch (error) { console.error(`INV ${inv.invoice}: ${error.message}`); problems++; }
  }
  // All new rows are on the statement before its PDF is exported.
  if (ready.length) {
    await writePlan(planStatementAgeing(await readGrid(), { today, sheetId }));
    const statementPdf = await driveExportFile(sourcingToken, STATEMENT_SPREADSHEET_ID, 'application/pdf');
    for (const inv of ready) {
      try {
        await ensureInvoiceDraft({ database, inv, dryRun: process.env.DRY_RUN === '1',
          findMessage: async (messageId) => {
            const messages = await searchMessages(sourcingToken, `in:anywhere rfc822msgid:${messageId}`);
            return Promise.all(messages.map((message) => getMessage(sourcingToken, message.id)));
          },
          createInvoiceDraft: (messageId) => createDraft(sourcingToken, {
            to: PLT_RECIPIENTS, subject: draftSubject([inv.invoice]), body: draftBody(1), messageId,
            attachments: [
              { filename: invoiceFilename(inv), mimeType: 'application/pdf', buffer: buildInvoicePdf(inv, { invoiceDate: inv.invoiceDate, createdAt: now }) },
              { filename: `PLT_Statement_Denovo_Sourcing_${dashDate(today)}.pdf`, mimeType: 'application/pdf', buffer: statementPdf },
            ],
          }),
        });
        console.log(`INV ${inv.invoice}: draft created or existing invoice email recovered.`);
      } catch (error) { console.error(`INV ${inv.invoice}: ${error.message}`); problems++; }
    }
  }
  if (problems) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('Fatal error:', error); process.exitCode = 1; });
}
