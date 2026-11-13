// Compare the packed cartons with the Portal's purchase-order lines before
// anything is entered. Orders are sometimes cut short, so packing under the
// ordered quantity only warns. Packing more than a few units over usually
// means a wrong packing list and stops the run.
export const DEFAULT_QUANTITY_TOLERANCE = { maxOver: 5 };

const key = (value) => String(value ?? '').trim().toUpperCase();

export function checkPortalQuantities(lines, cartons, { maxOver } = DEFAULT_QUANTITY_TOLERANCE) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('Portal purchase-order lines are unavailable');
  const groups = new Map();
  for (const carton of cartons) {
    const id = `${key(carton.baseSku)} size ${key(carton.size)}`;
    const group = groups.get(id) ?? { baseSku: key(carton.baseSku), size: key(carton.size), packed: 0 };
    group.packed += carton.quantity;
    groups.set(id, group);
  }
  const warnings = [];
  const errors = [];
  const matched = new Set();
  for (const [id, group] of groups) {
    const own = lines.filter((line) => key(line.sku).startsWith(group.baseSku) && key(line.size) === group.size);
    if (own.length === 0) { errors.push(`${id}: not on the Portal purchase order`); continue; }
    own.forEach((line) => matched.add(line));
    const ordered = own.reduce((sum, line) => sum + Number(line.quantity), 0);
    const difference = group.packed - ordered;
    if (difference > maxOver) errors.push(`${id}: packed ${group.packed} is ${difference} over the ordered ${ordered} (limit ${maxOver})`);
    else if (difference > 0) warnings.push(`${id}: packed ${group.packed} is ${difference} over the ordered ${ordered}`);
    else if (difference < 0) warnings.push(`${id}: packed ${group.packed} is ${-difference} under the ordered ${ordered}`);
  }
  for (const line of lines) {
    if (matched.has(line)) continue;
    const ordered = Number(line.quantity);
    const id = `${key(line.sku)} size ${key(line.size)}`;
    if (ordered > 0) warnings.push(`${id}: nothing packed against the ordered ${ordered}`);
  }
  return { warnings, errors };
}

// The wizard loads the PO through a batched tRPC call; pick the result that
// carries the purchase-order lines.
export function extractPurchaseOrderLines(batch) {
  for (const entry of Array.isArray(batch) ? batch : []) {
    const lines = entry?.result?.data?.json?.purchaseOrderLines;
    if (Array.isArray(lines)) return lines;
  }
  return null;
}
