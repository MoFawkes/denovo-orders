// Explicit manual correction only; never run by the hourly schedule.
import { getAccessToken, searchMessages, getMessage, listAttachments, getAttachment,
  sheetsGetValues, sendInvoiceMessage } from './lib/google.mjs';
import { buildStatementCsv, PLT_RECIPIENTS, londonToday, dashDate } from './lib/plt-invoice.mjs';
import { callPackingListDb } from './lib/automation-db.mjs';
import { getExecution, completeExecution } from './lib/execution-state.mjs';

const dryRun = process.env.DRY_RUN !== '0';
const header = (message, name) => message.payload.headers.find(item => item.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const token = await getAccessToken({ clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
  clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET, refreshToken: process.env.GMAIL_SOURCING_OAUTH_REFRESH_TOKEN });
let sourceId = process.env.ORIGINAL_MESSAGE_ID;
if (!sourceId) {
  if (!dryRun) throw new Error('Select the original message ID from a dry-run before sending');
  const candidates = await searchMessages(token, 'in:sent to:pltukinvoices@prettylittlething.com subject:Statement has:attachment');
  const messages = await Promise.all(candidates.map(message => getMessage(token, message.id)));
  const originals = messages.filter(message => /^Invoice \d+ and Statement$/.test(header(message, 'Subject')));
  if (!originals.length) console.log(JSON.stringify({ candidateCount: messages.length,
    candidates: messages.slice(0, 10).map(message => ({ id: message.id, subject: header(message, 'Subject'), messageId: header(message, 'Message-ID') })) }));
  originals.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
  sourceId = originals[0]?.id;
  if (!sourceId) throw new Error('No original automated invoice email found');
}
const source = await getMessage(token, sourceId);
if (!source.labelIds?.includes('SENT') || source.labelIds.includes('TRASH')) throw new Error('Original must be a sent message');
const invoice = header(source, 'Subject').match(/^Invoice (\d+) and Statement$/)?.[1];
if (!invoice) throw new Error('Original is not a single-invoice statement email');
if (!header(source, 'From').includes('denovosourcing@gmail.com')) throw new Error('Unexpected original sender');
for (const recipient of PLT_RECIPIENTS) {
  const email = recipient.match(/<([^>]+)>/)[1];
  if (!header(source, 'To').toLowerCase().includes(email)) throw new Error('Unexpected original recipients');
}
const attachments = listAttachments(source);
const invoicePdfs = attachments.filter(part => part.mimeType === 'application/pdf' && !/statement/i.test(part.filename));
if (invoicePdfs.length !== 1) throw new Error('Expected one original invoice PDF');
const pdf = invoicePdfs[0];
if (dryRun) console.log(JSON.stringify({ originalMessageId: source.id, subject: header(source, 'Subject'), originalAttachments: attachments.map(part => ({ filename: part.filename, mimeType: part.mimeType })) }));
if (!pdf.filename.match(new RegExp(`(^|[^0-9])${invoice}([^0-9]|$)`))) throw new Error('Invoice attachment filename differs from subject');
const messageId = `denovo-plt-invoice-${invoice}-csv-correction-v1@denovosourcing.com`;
const matches = await searchMessages(token, `in:anywhere rfc822msgid:${messageId}`);
if (matches.length) {
  if (matches.length !== 1 || !(await getMessage(token, matches[0].id)).labelIds?.includes('SENT')) throw new Error('Correction exists in unexpected state');
  console.log(`CSV correction already sent: ${matches[0].id}`);
} else {
  const spreadsheet = process.env.PLT_STATEMENT_SPREADSHEET_ID || '1DK9ht3fSXRopjnkZyufVPVsZaKB1jqnOndVWeYHMOy4';
  const sheet = process.env.PLT_STATEMENT_SHEET || 'PLT Statement';
  const grid = await sheetsGetValues(token, spreadsheet, `'${sheet.replaceAll("'", "''")}'!A:I`);
  const csv = buildStatementCsv(grid);
  const originalPdf = await getAttachment(token, source.id, pdf.attachmentId);
  if (!originalPdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid original PDF');
  const today = londonToday(new Date());
  const subject = `Invoice ${invoice} and Statement — CSV format`;
  const filename = `PLT_Statement_Denovo_Sourcing_${dashDate(today)}.csv`;
  console.log(JSON.stringify({ originalMessageId: source.id, originalSubject: header(source, 'Subject'), invoice,
    sentAt: new Date(Number(source.internalDate)).toISOString(), to: PLT_RECIPIENTS,
    subject, attachments: [pdf.filename, filename], csvBytes: csv.length, dryRun }));
  if (!dryRun) {
    const checkpoint = await getExecution(callPackingListDb, 'plt-invoice', invoice, 'csv-correction-send-started');
    if (checkpoint?.status === 'completed') throw new Error('Correction send was attempted; reconcile Sent before retrying');
    await completeExecution(callPackingListDb, 'plt-invoice', invoice, 'csv-correction-send-started', { message_id: messageId, original_message_id: source.id });
    const sent = await sendInvoiceMessage(token, { to: PLT_RECIPIENTS, subject, messageId,
      body: 'Hi,\nPlease find the statement attached in CSV format as requested, together with the original invoice PDF. This replaces the previous statement attachment; the invoice is unchanged.\nThanks\n',
      attachments: [{ filename: pdf.filename, mimeType: 'application/pdf', buffer: originalPdf },
        { filename, mimeType: 'text/csv; charset=utf-8', buffer: csv }] });
    console.log(`CSV correction sent: ${sent.id}`);
    await completeExecution(callPackingListDb, 'plt-invoice', invoice, 'csv-correction-sent', { message_id: sent.id, original_message_id: source.id });
  }
}
