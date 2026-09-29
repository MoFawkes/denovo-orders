// Strict CSV path: buyer style is mandatory; no PO-only or internal-style fallback.
export function validateCsvPairs(pairs) {
  return Array.isArray(pairs) && pairs.length > 0 && pairs.length <= 2000 && pairs.every(pair =>
    pair && typeof pair.po === 'string' && /^\d{10}$/.test(pair.po) &&
    typeof pair.style === 'string' && /^[A-Z0-9-]+$/.test(pair.style));
}

export async function approveCsvPairs(database, pairs) {
  let updated = 0, skipped = 0;
  const unmatched = [];
  for (const pair of pairs) {
    const poValues = [...new Set([pair.po, pair.po.replace(/^0+(?=\d)/, '')])];
    const match = await database.from('orders').select('id,stage').in('po', poValues).ilike('style', pair.style);
    if (match.error) throw new Error(match.error.message);
    if (!match.data.length) { unmatched.push(pair); continue; }
    const active = match.data.filter(order => !['Completed', 'Cancelled'].includes(order.stage));
    if (!active.length) { skipped++; continue; }
    const result = await database.from('orders').update({ sample_approved: true })
      .in('id', active.map(order => order.id)).in('po', poValues).ilike('style', pair.style)
      .not('stage', 'in', '(Completed,Cancelled)').or('sample_approved.eq.false,sample_approved.is.null').select('id');
    if (result.error) throw new Error(result.error.message);
    updated += result.data.length;
    skipped += active.length - result.data.length;
  }
  return { updated, skipped, unmatched };
}
