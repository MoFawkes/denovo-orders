import test from 'node:test';
import assert from 'node:assert/strict';
import { hasChecksumProblem } from '../draft-packing-list.mjs';

test('requests a corrective photo read for carton checksum mismatches', () => {
  assert.equal(hasChecksumProblem([
    'docket #367: carton quantities add up to 480 but the written total is 500',
  ]), true);
  assert.equal(hasChecksumProblem([
    'docket #367: extracted 9 cartons but the written box count is 10',
  ]), true);
});

test('does not retry business-rule failures that another photo read cannot fix', () => {
  assert.equal(hasChecksumProblem(['docket #367: PO must be a 10-digit string']), false);
  assert.equal(hasChecksumProblem(['photos span 2 different POs — send one PO per email']), false);
});
