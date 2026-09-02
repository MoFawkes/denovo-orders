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

export async function redirectToPortalRoot(page, targetUrl, navigationMs) {
  const rootUrl = new URL('/', targetUrl).href;
  const rootResponse = await page.goto(rootUrl, {
    waitUntil: 'domcontentloaded', timeout: navigationMs,
  });
  await assertPortalAccess(rootResponse, page, 'manual root redirect after authentication callback');
  return rootResponse;
}

export async function recoverPortalRedirect(response, page, targetUrl, navigationMs) {
  if (response?.status?.() !== 401) return response;
  await redirectToPortalRoot(page, targetUrl, navigationMs);
  const retryResponse = await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded', timeout: navigationMs,
  });
  await assertPortalAccess(retryResponse, page, 'navigation after manual root redirect');
  return retryResponse;
}
export async function clearPortalSearchFilters(page, navigationMs) {
  const clearAll = page.getByRole('button', { name: 'Clear all', exact: true })
    .or(page.getByText('Clear all', { exact: true }))
    .first();
  if (!await clearAll.isVisible().catch(() => false)) return false;

  await clearAll.click();
  await page.waitForLoadState('networkidle', { timeout: navigationMs }).catch(() => {});
  return true;
}