import { getHeader } from './google.mjs';

export function parseSampleApprovalCSV(text) {
  const records = []
  let row = [], value = '', quoted = false, closed = false
  const finishField = () => { row.push(value.trim()); value = ''; closed = false }
  const finishRow = () => {
    finishField()
    if (row.some(cell => cell !== '')) records.push(row)
    row = []
  }
  text = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++ }
      else if (c === '"') { quoted = false; closed = true }
      else value += c
    } else if (c === ',') finishField()
    else if (c === '\n' || c === '\r') {
      finishRow()
      if (c === '\r' && text[i + 1] === '\n') i++
    } else if (c === '"') {
      if (value.trim() || closed) throw new Error('Invalid CSV quoting.')
      value = ''; quoted = true
    } else {
      if (closed && c.trim()) throw new Error('Invalid text after a quoted CSV field.')
      value += c
    }
  }
  if (quoted) throw new Error('The CSV has an unclosed quoted field.')
  finishRow()
  const headers = (records.shift() || []).map(h => h.toLowerCase())
  const required = ['po', 'style', 'sage sample approved']
  if (required.some(h => headers.filter(v => v === h).length !== 1)) {
    throw new Error('Expected one each of these columns: PO, Style, Sage Sample Approved.')
  }
  if (!records.length) throw new Error('The CSV contains no order rows.')
  return records.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error('CSV row ' + (index + 2) + ' has the wrong number of columns.')
    return { po: cells[headers.indexOf('po')], style: cells[headers.indexOf('style')].toUpperCase(), approval: cells[headers.indexOf('sage sample approved')].toLowerCase() }
  })
}


export function isBuyerChase(message) {
  const from = getHeader(message, 'From').trim();
  const address = (from.match(/<([^<>]+)>$/)?.[1] ?? from).toLowerCase();
  return address === 'lulu.marshall@prettylittlething.com' &&
    /^Dresses OPO Chase - Denovo Sourcing - /i.test(getHeader(message, 'Subject'));
}

export function hasBuyerAuthentication(message) {
  // Require Gmail's authentication result, not a display-name/domain substring.
  const auth = (message.payload?.headers ?? []).filter(h => h.name.toLowerCase() === 'authentication-results')
    .map(h => h.value).find(v => /^mx\.google\.com;/i.test(v.trim()));
  return !!auth && /\bdkim=pass\b[^;]*header\.i=@prettylittlething\.com(?:[;\s]|$)/i.test(auth) &&
    /\bdmarc=pass\b[^;]*header\.from=prettylittlething\.com(?:[;\s]|$)/i.test(auth);
}

export function planCsvApprovals(rows) {
  const normalized = rows.map(row => ({ ...row, po: /^\d{1,10}$/.test(row.po) ? row.po.padStart(10, '0') : '' }));
  const counts = new Map();
  const key = row => JSON.stringify([row.po, row.style]);
  normalized.forEach(row => counts.set(key(row), (counts.get(key(row)) ?? 0) + 1));
  const pairs = [], issues = [];
  for (const row of normalized) {
    if (!row.po || !/^[A-Z0-9-]+$/.test(row.style) || !['yes', 'no'].includes(row.approval) || counts.get(key(row)) > 1) {
      issues.push('Invalid or duplicate PO/style: ' + row.po + ' / ' + row.style);
    } else if (row.approval === 'yes') pairs.push({ po: row.po, style: row.style });
  }
  return { pairs, issues };
}

export async function processChaseMessage(message, { readAttachment, approve, label, dryRun = false }) {
  if (!isBuyerChase(message)) return { skipped: true };
  if (!hasBuyerAuthentication(message)) { await label('review'); return { review: true }; }
  const attachments = [];
  function walk(part) {
    if (/\.csv$/i.test(part.filename ?? '')) attachments.push(part);
    (part.parts ?? []).forEach(walk);
  }
  walk(message.payload ?? {});
  if (!attachments.length) { await label('review'); return { review: true }; }
  let plan;
  try {
    const rows = [];
    for (const part of attachments) {
      if ((part.body?.size ?? 0) > 2_000_000) throw new Error('CSV exceeds 2 MB');
      const text = part.body?.data != null ? Buffer.from(part.body.data, 'base64url').toString('utf8') : await readAttachment(part.body?.attachmentId);
      rows.push(...parseSampleApprovalCSV(text));
    }
    if (rows.length > 2000) throw new Error('CSV exceeds 2,000 rows');
    plan = planCsvApprovals(rows);
  } catch (error) {
    // Download failures are retried; invalid CSVs are surfaced for review.
    if (error.retryable) throw error;
    console.error('CSV needs review:', error.message);
    await label('review');
    return { review: true };
  }
  if (dryRun) {
    console.log('[dry-run] CSV approvals:', JSON.stringify(plan));
    return { dryRun: true, pairs: plan.pairs };
  }
  // Send pairs as a batch. Older endpoints reject this shape (no top-level PO),
  // so rollout cannot accidentally use the legacy PO-only matching fallback.
  const result = plan.pairs.length ? await approve(plan.pairs) : { unmatched: [] };
  if (!Array.isArray(result.unmatched)) throw new Error('Unexpected CSV approval response');
  const review = plan.issues.length > 0 || result.unmatched.length > 0;
  console.log(JSON.stringify({ message: message.id, ...result, issues: plan.issues }));
  await label(review ? 'review' : 'processed');
  return { review, ...result };
}
