import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPortalAccess, PortalAccessDeniedError, recoverPortalRedirect, clearPortalSearchFilters } from '../lib/portal-access.mjs';

const page = (title) => ({ title: async () => title });
const response = (status, headers = {}) => ({
  status: () => status,
  allHeaders: async () => headers,
});

test('accepts a normal Portal or Cognito response', async () => {
  await assert.doesNotReject(assertPortalAccess(response(200), page('ISC Portal'), 'initial navigation'));
});

test('identifies an ALB 403 before credentials are submitted', async () => {
  await assert.rejects(
    assertPortalAccess(response(403, { server: 'awselb/2.0' }), page('403 Forbidden'), 'initial navigation'),
    (error) => {
      assert.ok(error instanceof PortalAccessDeniedError);
      assert.equal(error.details.server, 'awselb/2.0');
      assert.match(error.message, /No credentials were submitted/);
      assert.match(error.message, /do not retry repeatedly/);
      return true;
    },
  );
});

test('detects a forbidden page even when no navigation response is available', async () => {
  await assert.rejects(
    assertPortalAccess(null, page('403 Forbidden'), 'Cognito callback'),
    /403 Forbidden/,
  );
});

test('includes Retry-After without inventing a delay when the server supplies one', async () => {
  await assert.rejects(
    assertPortalAccess(response(403, { server: 'awselb/2.0', 'retry-after': '3600' }), page('403 Forbidden'), 'navigation'),
    /Retry-After: 3600/,
  );
});
test('a 401 visits the Portal root once before retrying the target page', async () => {
  const visits = [];
  const replies = [response(200), response(200)];
  const mockPage = {
    title: async () => 'ISC Portal',
    goto: async (url, options) => {
      visits.push({ type: 'goto', url, options });
      return replies.shift();
    },
    waitForLoadState: async (state) => visits.push({ type: 'load', state }),
    waitForTimeout: async (milliseconds) => visits.push({ type: 'pause', milliseconds }),
  };

  const recovered = await recoverPortalRedirect(
    response(401),
    mockPage,
    'https://isc-portal.debenhamsgroup.com/en/ssccLabels/purchaseOrders',
    30000,
  );

  assert.equal(recovered.status(), 200);
  assert.deepEqual(visits.map((visit) => visit.type), ['goto', 'load', 'pause', 'goto']);
  assert.equal(visits[0].url, 'https://isc-portal.debenhamsgroup.com/');
  assert.equal(visits[1].state, 'networkidle');
  assert.equal(visits[2].milliseconds, 3000);
  assert.equal(visits[3].url, 'https://isc-portal.debenhamsgroup.com/en/ssccLabels/purchaseOrders');
});

test('a non-401 response does not trigger redirect recovery', async () => {
  const original = response(200);
  const recovered = await recoverPortalRedirect(
    original,
    { goto: async () => assert.fail('goto should not run') },
    'https://isc-portal.debenhamsgroup.com/en/ssccLabels/purchaseOrders',
    30000,
  );
  assert.equal(recovered, original);
});
test('clears active Portal filters before a PO search', async () => {
  const actions = [];
  const locator = {
    or: () => locator,
    first: () => locator,
    isVisible: async () => true,
    click: async () => actions.push('clicked'),
  };
  const cleared = await clearPortalSearchFilters({
    getByRole: () => locator,
    getByText: () => locator,
    waitForLoadState: async (state) => actions.push(state),
  }, 30000);

  assert.equal(cleared, true);
  assert.deepEqual(actions, ['clicked', 'networkidle']);
});

test('does nothing when the Portal has no active filters', async () => {
  const locator = {
    or: () => locator,
    first: () => locator,
    isVisible: async () => false,
    click: async () => assert.fail('click should not run'),
  };
  const cleared = await clearPortalSearchFilters({
    getByRole: () => locator,
    getByText: () => locator,
  }, 30000);
  assert.equal(cleared, false);
});