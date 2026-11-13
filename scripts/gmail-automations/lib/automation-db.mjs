const FUNCTIONS_URL =
  process.env.SUPABASE_FUNCTIONS_URL ?? 'https://sfwnmddlmiprvsoxbatz.supabase.co/functions/v1';

// Read-only actions are safe to repeat, so a transient gateway error from
// Supabase/Cloudflare (e.g. HTTP 520) must not fail the whole automation step.
// Writes are never retried here: a gateway error does not say whether the
// write was applied, and each script already resumes from its checkpoints.
const RETRYABLE_ACTIONS = new Set([
  'snapshot', 'orders-for-po', 'buyer-reference-get', 'checkpoint-get', 'portal-submission-get',
]);
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504, 520, 521, 522, 523, 524]);
const RETRY_DELAYS_MS = [1000, 4000, 10000];
const MAX_ERROR_BODY = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function callPackingListDb(action, payload = {}, { retryDelaysMs = RETRY_DELAYS_MS } = {}) {
  const delays = RETRYABLE_ACTIONS.has(action) ? retryDelaysMs : [];
  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < delays.length;
    let response;
    try {
      response = await fetch(`${FUNCTIONS_URL}/packing-list-db`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-automation-secret': process.env.PACKING_LIST_DB_SECRET,
        },
        body: JSON.stringify({ action, ...payload }),
      });
    } catch (error) {
      if (!canRetry) throw new Error(`packing-list-db ${action} failed: ${error.message}`, { cause: error });
      console.warn(`packing-list-db ${action}: ${error.message}; retrying (${attempt + 1}/${delays.length})`);
      await sleep(delays[attempt]);
      continue;
    }
    if (response.ok) return response.json();
    if (canRetry && TRANSIENT_STATUSES.has(response.status)) {
      console.warn(`packing-list-db ${action}: HTTP ${response.status}; retrying (${attempt + 1}/${delays.length})`);
      await sleep(delays[attempt]);
      continue;
    }
    // Gateway errors return a whole HTML page; keep the log readable.
    const body = (await response.text()).replace(/\s+/g, ' ').trim();
    const shown = body.length > MAX_ERROR_BODY ? `${body.slice(0, MAX_ERROR_BODY)}…` : body;
    throw new Error(`packing-list-db ${action} failed: HTTP ${response.status}: ${shown}`);
  }
}
