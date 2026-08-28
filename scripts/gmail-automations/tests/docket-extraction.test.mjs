import test from 'node:test';
import assert from 'node:assert/strict';
import {
  docketExtractionProblems,
  needsQuantityRetry,
  selectBetterExtraction,
} from '../lib/docket-extraction.mjs';

const docket = (overrides = {}) => ({
  docket_no: '367', po: '0070067000', sku: 'ABC',
  cartons: [{ size: '8', qty: 20, small: false }],
  written_total: 20, written_boxes: 1, written_small_boxes: null,
  unreadable: false, problem: null,
  ...overrides,
});

test('quantity and box checksum problems trigger a targeted vision retry', () => {
  assert.equal(needsQuantityRetry(docketExtractionProblems({ dockets: [docket({ written_total: 60 })] })), true);
  assert.equal(needsQuantityRetry(docketExtractionProblems({ dockets: [docket({ written_boxes: 2 })] })), true);
});

test('non-quantity validation problems do not trigger a targeted retry', () => {
  assert.equal(needsQuantityRetry(docketExtractionProblems({ dockets: [docket({ unreadable: true, problem: 'blurred' })] })), false);
});

test('accepts a retry only when it reduces validation problems', () => {
  const first = { dockets: [docket({ written_total: 60 })] };
  const validRetry = { dockets: [docket()] };
  const badRetry = { dockets: [docket({ written_total: 70 })] };
  assert.equal(selectBetterExtraction(first, validRetry), validRetry);
  assert.equal(selectBetterExtraction(first, badRetry), first);
});
