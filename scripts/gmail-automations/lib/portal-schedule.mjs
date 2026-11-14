// Decides whether an hourly (scheduled) run may submit to the Portal.
// PORTAL_SCHEDULED_ENABLED is the explicit switch: '1' on, '0' off. With
// neither set, submission is allowed only up to and including the trial end
// date (YYYY-MM-DD, Europe/London), so a trial switches itself off.
export function scheduledSubmissionEnabled(env, now = new Date()) {
  const flag = String(env.PORTAL_SCHEDULED_ENABLED ?? '').trim();
  if (flag === '1') return true;
  if (flag === '0') return false;
  const until = String(env.PORTAL_SCHEDULED_TRIAL_UNTIL ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return false;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
  return today <= until;
}
