import { createHash } from 'node:crypto';
import { validDate, planStatementUpdate, dashDate } from './plt-invoice.mjs';
import { getExecution, completeExecution } from './execution-state.mjs';

const clean = value => String(value ?? '').trim();
const numericRef = value => clean(value).replace(/^0+(?=\d)/, '');
const NOTE_MARKER = 'DENOVO_REMITTANCE_V1:';
const fail = message => { const error = new Error(`Remittance: ${message}`); error.needsReview = true; throw error; };

export function validateRemittance(input) {
  if (input?.uncertain !== false || input.currency !== 'GBP' || input.supplierCode !== 'DEN0203A' ||
      !/prettylittlething\.com\s+limited/i.test(input.payer ?? '') || !validDate(input.date) ||
      !/^[A-Za-z0-9-]{1,50}$/.test(input.reference ?? '') || !Array.isArray(input.lines) || !input.lines.length) {
    fail('uncertain extraction or unexpected payer, supplier, currency, date or reference');
  }
  if (!Number.isSafeInteger(input.totalPence) || input.totalPence < 0) fail('invalid remittance total');
  const seen = new Set();
  const lines = input.lines.map(line => {
    if (!validDate(line.date) || !['PI', 'PC'].includes(line.type) ||
        !/^[A-Za-z0-9-]{1,50}$/.test(line.reference ?? '') ||
        !Number.isSafeInteger(line.amountPence) || line.amountPence <= 0 ||
        !(line.po === 'Discount' || /^\d{6,10}$/.test(line.po ?? ''))) fail('invalid or unsupported line');
    if (line.type === 'PI' && !/^\d+$/.test(line.reference)) fail('invoice reference must be numeric');
    const normalized = { date: line.date, po: line.po === 'Discount' ? 'Discount' : numericRef(line.po),
      reference: line.type === 'PI' ? numericRef(line.reference) : clean(line.reference), type: line.type, amountPence: line.amountPence };
    const key = `${normalized.type}:${normalized.reference}`;
    if (seen.has(key)) fail('duplicate line reference');
    seen.add(key);
    return normalized;
  });
  const net = lines.reduce((sum, line) => sum + (line.type === 'PI' ? line.amountPence : -line.amountPence), 0);
  if (!Number.isSafeInteger(net) || net !== input.totalPence) fail('invoice payments minus deductions do not equal the total');
  return { payer: 'prettylittlething.com Limited', supplierCode: 'DEN0203A', currency: 'GBP',
    reference: /^\d+$/.test(input.reference) ? numericRef(input.reference) : input.reference, date: input.date, totalPence: input.totalPence,
    lines: lines.sort((a, b) => `${a.type}:${a.reference}`.localeCompare(`${b.type}:${b.reference}`)) };
}

export const remittanceId = remittance => `${remittance.supplierCode}:${remittance.date}:${remittance.reference}`;
export const remittanceDigest = remittance => createHash('sha256').update(JSON.stringify(remittance)).digest('hex');

function readHistory(note) {
  const line = clean(note).split('\n').find(value => value.startsWith(NOTE_MARKER));
  if (!line) return { payments: [] };
  try {
    const parsed = JSON.parse(line.slice(NOTE_MARKER.length));
    if (!Array.isArray(parsed.payments)) fail('invalid payment history');
    return parsed;
  } catch { fail('corrupt payment history note'); }
}

// The note marker, amount/status changes, hidden paid rows and charges commit
// in one Sheets transaction. Reading notes makes retries safe after a timeout.
export function planRemittance(grid, notes, remittance, { today, sheetId }) {
  const rows = grid.map(row => [...row]);
  const id = remittanceId(remittance), digest = remittanceDigest(remittance);
  const requests = [], updates = [];
  const pendingCharges = [];
  const audit = [];
  const setNote = (row, column, note) => requests.push({ updateCells: {
    start: { sheetId, rowIndex: row, columnIndex: column }, rows: [{ values: [{ note }] }], fields: 'note',
  } });
  for (const line of remittance.lines) {
    if (line.type === 'PC') {
      const chargeRef = `CHARGE ${line.reference}`;
      const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) => clean(row[0]) === chargeRef);
      if (matches.length > 1) fail(`multiple charge rows for ${line.reference}`);
      if (matches.length) {
        const existing = matches[0];
        const history = readHistory(notes.get(`${existing.index}:0`));
        if (history.remittance !== id || history.digest !== digest || Math.round(Number(existing.row[3]) * 100) !== line.amountPence) {
          fail(`existing charge ${line.reference} needs reconciliation`);
        }
      } else {
        // A manual credit/charge with the same reference must not be duplicated.
        if (rows.some(row => clean(row[0]).replace(/^0+(?=\d)/, '') === numericRef(line.reference))) {
          fail(`manual charge ${line.reference} already exists; reconcile before import`);
        }
        pendingCharges.push({ line, values: [chargeRef, dashDate(line.date), line.po, line.amountPence / 100, 'Immediate', 'OVERDUE / DISPUTED'] });
      }
      audit.push({ type: 'disputed-charge', reference: line.reference, amountPence: line.amountPence });
      continue;
    }
    const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) => /^\d+$/.test(clean(row[0])) && numericRef(row[0]) === line.reference);
    if (matches.length !== 1) fail(`invoice ${line.reference} needs one matching statement row; found ${matches.length}`);
    const { row, index } = matches[0];
    if (numericRef(row[2]) !== line.po) fail(`invoice ${line.reference} PO mismatch`);
    const oldNote = notes.get(`${index}:3`) ?? '';
    const history = readHistory(oldNote);
    const previous = history.payments.find(payment => payment.id === id);
    if (previous) {
      if (previous.digest !== digest || previous.amountPence !== line.amountPence) fail('changed previously applied remittance');
      continue;
    }
    if (/^(paid|settled)$/i.test(clean(row[5]))) fail(`invoice ${line.reference} already settled manually`);
    const balance = Math.round(Number(row[3]) * 100);
    if (!Number.isSafeInteger(balance) || balance <= 0 || line.amountPence > balance) fail(`invoice ${line.reference} payment exceeds outstanding balance`);
    const remaining = balance - line.amountPence;
    history.originalPence ??= balance;
    history.payments.push({ id, digest, date: remittance.date, amountPence: line.amountPence });
    const preserved = oldNote.split('\n').filter(value => !value.startsWith(NOTE_MARKER)).join('\n').trim();
    setNote(index, 3, [preserved, NOTE_MARKER + JSON.stringify(history)].filter(Boolean).join('\n'));
    // Retain the full original amount on fully settled hidden rows for audit.
    row[3] = remaining ? remaining / 100 : balance / 100;
    if (!remaining) {
      row[5] = 'PAID';
      requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
    }
    updates.push({ range: `D${index + 1}:F${index + 1}`, values: [[row[3], row[4], row[5]]], raw: true });
    audit.push({ type: remaining ? 'partial-payment' : 'paid', reference: line.reference, amountPence: line.amountPence, remainingPence: remaining });
  }
  if (pendingCharges.length) {
    const at = rows.findIndex(row => /^subtotal/i.test(clean(row[0])) && /overdue/i.test(clean(row[0])));
    if (at < 0) fail('no Overdue subtotal section');
    // Value and note requests before this insert use the original row indices.
    for (const update of updates.splice(0)) {
      const match = update.range.match(/^D(\d+)/);
      requests.push({ updateCells: { start: { sheetId, rowIndex: Number(match[1]) - 1, columnIndex: 3 },
        rows: [{ values: update.values[0].map(value => ({ userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: String(value ?? '') } })) }], fields: 'userEnteredValue' } });
    }
    requests.push({ insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: at, endIndex: at + pendingCharges.length }, inheritFromBefore: false } });
    rows.splice(at, 0, ...pendingCharges.map(charge => charge.values));
    pendingCharges.forEach(({ values }, offset) => {
      updates.push({ range: `A${at + offset + 1}:F${at + offset + 1}`, values: [values], raw: true });
      setNote(at + offset, 0, NOTE_MARKER + JSON.stringify({ payments: [], remittance: id, digest }));
    });
    requests.push({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: at, endIndex: at + pendingCharges.length }, properties: { hiddenByUser: false }, fields: 'hiddenByUser' } });
  }
  updates.push(...planStatementUpdate(rows, [], { today }).updates);
  return { requests, updates, audit };
}

export async function applyRemittance({ database, remittance, readStatement, writePlan, today, sheetId, dryRun = false }) {
  const id = remittanceId(remittance), digest = remittanceDigest(remittance);
  const done = await getExecution(database, 'plt-remittance', id, 'applied');
  if (done?.status === 'completed') {
    if (done.result.digest !== digest) fail('same remittance reference has different contents');
    return { skipped: true };
  }
  const saved = await getExecution(database, 'plt-remittance', id, 'prepared');
  if (saved?.status === 'completed' && saved.result.digest !== digest) fail('prepared remittance differs');
  const { grid, notes } = await readStatement();
  const plan = planRemittance(grid, notes, remittance, { today, sheetId });
  if (!dryRun && saved?.status !== 'completed') await completeExecution(database, 'plt-remittance', id, 'prepared', { digest, remittance });
  await writePlan(plan);
  if (!dryRun) await completeExecution(database, 'plt-remittance', id, 'applied', { digest, audit: plan.audit });
  return { audit: plan.audit };
}
