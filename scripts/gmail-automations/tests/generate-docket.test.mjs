// Regression tests for the productName size/colour parsing in
// generate-docket.mjs. The PLT export changed the size suffix from
// `...Colour-2` to `...Colour - UK 2` mid-July 2026, which parsed no sizes and
// left every docket save with an empty `rows` array (HTTP 400). These pin both
// the new and legacy suffix forms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSizeFromName, extractColourFromName } from '../generate-docket.mjs';

test('extractSizeFromName reads the new " - UK <n>" suffix', () => {
  assert.equal(extractSizeFromName('Petite Black Scoop Neck Sleeveless Maxi Dress Black - UK 2'), '2');
  assert.equal(extractSizeFromName('Some Dress Lemon - UK 16'), '16');
});

test('extractSizeFromName still reads the legacy "-<n>" suffix', () => {
  assert.equal(extractSizeFromName('Petite Black Scoop Neck Sleeveless Maxi Dress Black-2'), '2');
});

test('extractSizeFromName returns null when there is no size suffix', () => {
  assert.equal(extractSizeFromName('Petite Black Scoop Neck Sleeveless Maxi Dress'), null);
});

test('extractColourFromName reads the colour past the new " - UK <n>" suffix', () => {
  assert.equal(extractColourFromName('Petite Black Scoop Neck Sleeveless Maxi Dress Black - UK 2'), 'Black');
});

test('extractColourFromName still reads the colour past the legacy "-<n>" suffix', () => {
  assert.equal(extractColourFromName('Petite Black Scoop Neck Sleeveless Maxi Dress Black-2'), 'Black');
});
