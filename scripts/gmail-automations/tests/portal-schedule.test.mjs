import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduledSubmissionEnabled } from '../lib/portal-schedule.mjs';

const during = new Date('2026-11-21T23:30:00Z');
const after = new Date('2026-11-22T00:30:00Z');

test('the explicit switch wins over the trial date', () => {
  assert.equal(scheduledSubmissionEnabled({ PORTAL_SCHEDULED_ENABLED: '1' }, after), true);
  assert.equal(scheduledSubmissionEnabled({ PORTAL_SCHEDULED_ENABLED: '0', PORTAL_SCHEDULED_TRIAL_UNTIL: '2026-11-21' }, during), false);
});

test('without the switch, submission runs only up to the trial end date', () => {
  assert.equal(scheduledSubmissionEnabled({ PORTAL_SCHEDULED_TRIAL_UNTIL: '2026-11-21' }, during), true);
  assert.equal(scheduledSubmissionEnabled({ PORTAL_SCHEDULED_TRIAL_UNTIL: '2026-11-21' }, after), false);
});

test('no switch and no valid trial date means disabled', () => {
  assert.equal(scheduledSubmissionEnabled({}, during), false);
  assert.equal(scheduledSubmissionEnabled({ PORTAL_SCHEDULED_TRIAL_UNTIL: 'next week' }, during), false);
});
