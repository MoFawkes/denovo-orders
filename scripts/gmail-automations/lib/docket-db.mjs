const FUNCTIONS_URL =
  process.env.SUPABASE_FUNCTIONS_URL ?? 'https://sfwnmddlmiprvsoxbatz.supabase.co/functions/v1';

export async function callDocketDb(action, payload = {}) {
  const response = await fetch(`${FUNCTIONS_URL}/docket-db`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-automation-secret': process.env.DOCKET_DB_SECRET,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!response.ok) throw new Error(`docket-db ${action} failed: HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

