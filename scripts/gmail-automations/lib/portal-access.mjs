export class PortalAccessDeniedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PortalAccessDeniedError';
    this.details = details;
  }
}

export async function assertPortalAccess(response, page, stage) {
  const status = response?.status?.() ?? null;
  const headers = response?.allHeaders ? await response.allHeaders() : {};
  const title = await page.title().catch(() => '');
  if (status !== 403 && title !== '403 Forbidden') return;

  const server = headers.server ?? 'unknown server';
  const retryAfter = headers['retry-after'] ?? null;
  const retryNote = retryAfter ? ` Retry-After: ${retryAfter}.` : '';
  throw new PortalAccessDeniedError(
    `ISC Portal returned 403 Forbidden from ${server} during ${stage}.${retryNote} ` +
      'No credentials were submitted; do not retry repeatedly. Wait for the operational cooldown, then escalate to Debenhams Group IT if the block persists.',
    { status: 403, server, retryAfter, stage },
  );
}
