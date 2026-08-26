export function parsePortalSampleApproval(pageText) {
  const text = String(pageText ?? '');
  if (/sample has not been approved/i.test(text) || /Sample Approved:\s*No\b/i.test(text)) return false;
  if (/Sample Approved:\s*Yes\b/i.test(text)) return true;
  return null;
}