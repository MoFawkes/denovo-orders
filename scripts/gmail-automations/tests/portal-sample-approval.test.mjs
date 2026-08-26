import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePortalSampleApproval } from '../lib/portal-sample-approval.mjs';

test('detects the new Portal unapproved banner', () => {
  assert.equal(parsePortalSampleApproval('This purchase order cannot be submitted as the sample has not been approved. Please contact the Buying and Merch team.'), false);
});

test('reads the Sample Approved value shown in the Carton Wizard', () => {
  assert.equal(parsePortalSampleApproval('Book Handover By: 28/08/2026\nSample Approved: No'), false);
  assert.equal(parsePortalSampleApproval('Book Handover By: 28/08/2026\nSample Approved: Yes'), true);
});

test('returns unknown when the Portal page has no approval signal', () => {
  assert.equal(parsePortalSampleApproval('My Purchase Orders'), null);
});