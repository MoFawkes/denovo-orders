const FUNCTIONS_URL =
  process.env.SUPABASE_FUNCTIONS_URL ?? 'https://sfwnmddlmiprvsoxbatz.supabase.co/functions/v1';

export async function callPackingListDb(action, payload = {}) {
  const response = await fetch(`${FUNCTIONS_URL}/packing-list-db`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-automation-secret': process.env.PACKING_LIST_DB_SECRET,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!response.ok) {
    throw new Error(`packing-list-db ${action} failed: HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

