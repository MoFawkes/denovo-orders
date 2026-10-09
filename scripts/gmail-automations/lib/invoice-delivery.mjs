import { getExecution, completeExecution } from './execution-state.mjs';
import { statementInvoiceNumbers, statementRowMatches, planStatementUpdate } from './plt-invoice.mjs';

const AUTOMATION = 'plt-invoice';
export const invoiceMessageId = (invoice) => `denovo-plt-invoice-${invoice}@denovosourcing.com`;

// Persist data before Sheets writes; a committed row can then be recovered
// when the following checkpoint fails. Always verify its PO and amount.
export async function ensureInvoiceStatement({ database, inv, today, readGrid, writePlan, validatePdf }) {
  const source = String(inv.invoice);
  const drafted = await getExecution(database, AUTOMATION, source, 'draft-created');
  if (drafted?.status === 'completed' && drafted.result?.skipped) return null;
  const prepared = await getExecution(database, AUTOMATION, source, 'prepared');
  const grid = await readGrid();
  const exists = statementInvoiceNumbers(grid).has(source);
  if (!prepared && exists) {
    const previous = await getExecution(database, AUTOMATION, source, 'statement-row');
    if (previous?.status !== 'completed') {
      await completeExecution(database, AUTOMATION, source, 'draft-created', { skipped: 'already on statement' });
      return null;
    }
    inv = { ...inv, invoiceDate: previous.result?.invoice_date ?? today };
  } else if (prepared?.status === 'completed') {
    inv = prepared.result.invoice;
    if (!inv || String(inv.invoice) !== source) throw new Error(`INV ${source}: invalid saved invoice record`);
  } else inv = { ...inv, invoiceDate: today };
  validatePdf(inv);
  if (exists) statementRowMatches(grid, inv);
  if (prepared?.status !== 'completed') await completeExecution(database, AUTOMATION, source, 'prepared', { invoice: inv });
  if (!exists) await writePlan(planStatementUpdate(grid, [inv], { today }));
  await completeExecution(database, AUTOMATION, source, 'statement-row', {
    invoice_date: inv.invoiceDate, po: inv.po, total_pence: inv.totalPence,
  });
  return inv;
}

export async function ensureInvoiceSent({ database, inv, findMessage, sendInvoice, dryRun = false }) {
  const source = String(inv.invoice);
  const done = await getExecution(database, AUTOMATION, source, 'email-sent');
  if (done?.status === 'completed') return { skipped: true };
  const messageId = invoiceMessageId(source);
  const matches = await findMessage(messageId);
  if (matches.length > 1) throw new Error(`INV ${source}: multiple matching emails; reconcile manually`);
  if (matches.length === 1) {
    const message = matches[0];
    if (!message.labelIds?.includes('SENT') || message.labelIds.includes('TRASH')) {
      throw new Error(`INV ${source}: existing draft or deleted email; reconcile manually before automatic sending`);
    }
    if (!dryRun) await completeExecution(database, AUTOMATION, source, 'email-sent', { message_id: message.id, recovered: true });
    return { recovered: true };
  }
  const started = await getExecution(database, AUTOMATION, source, 'email-send-started');
  if (started?.status === 'completed') throw new Error(`INV ${source}: sending was attempted but no Sent message is visible; reconcile before retrying`);
  if (dryRun) return sendInvoice(messageId);
  await completeExecution(database, AUTOMATION, source, 'email-send-started', { message_id: messageId });
  const message = await sendInvoice(messageId);
  await completeExecution(database, AUTOMATION, source, 'email-sent', { message_id: message.id });
  return message;
}

// Gmail drafts.create has no idempotency key. Recover by stable RFC Message-ID;
// never blindly retry an ambiguous POST. Each invoice gets its own draft.
export async function ensureInvoiceDraft({ database, inv, findMessage, createInvoiceDraft, dryRun = false }) {
  const source = String(inv.invoice);
  const done = await getExecution(database, AUTOMATION, source, 'draft-created');
  if (done?.status === 'completed') return { skipped: true };
  const messageId = invoiceMessageId(source);
  const matches = await findMessage(messageId);
  if (matches.length > 1) throw new Error(`INV ${source}: multiple matching invoice emails; reconcile manually`);
  if (matches.length === 1) {
    const message = matches[0];
    if (message.labelIds?.includes('TRASH') || (!message.labelIds?.includes('DRAFT') && !message.labelIds?.includes('SENT'))) {
      throw new Error(`INV ${source}: invoice email was deleted or has an unexpected state; reconcile manually`);
    }
    await completeExecution(database, AUTOMATION, source, 'draft-created', {
      message_id: message.id, recovered: true, sent: message.labelIds.includes('SENT'),
    });
    return { recovered: true };
  }
  const started = await getExecution(database, AUTOMATION, source, 'draft-started');
  if (started?.status === 'completed') {
    throw new Error(`INV ${source}: a draft creation was attempted but no matching email is visible; check Drafts, Sent and Bin before resetting draft-started`);
  }
  if (dryRun) return createInvoiceDraft(messageId);
  await completeExecution(database, AUTOMATION, source, 'draft-started', { message_id: messageId });
  const draft = await createInvoiceDraft(messageId);
  await completeExecution(database, AUTOMATION, source, 'draft-created', { draft_id: draft.id, message_id: draft.message?.id });
  return draft;
}
