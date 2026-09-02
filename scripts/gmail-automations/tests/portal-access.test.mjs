import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPortalAccess, PortalAccessDeniedError, recoverPortalRedirect } from '../lib/portal-access.mjs';

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
      visits.push({ url, options });
      return replies.shift();
    },
  };

  const recovered = await recoverPortalRedirect(
    response(401),
    mockPage,
    'https://isc-portal.debenhamsgroup.com/en/ssccLabels/purchaseOrders',
    30000,
  );

  assert.equal(recovered.status(), 200);
  assert.deepEqual(visits.map((visit) => visit.url), [
    'https://isc-portal.debenhamsgroup.com/',
    'https://isc-portal.debenhamsgroup.com/en/ssccLabels/purchaseOrders',
  ]);
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
