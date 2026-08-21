const TERMINAL_OR_POST_SUBMIT = new Set([
  'portal-submitted', 'bels-generated', 'bels-downloaded', 'delivered', 'uncertain-after-submit',
]);

export async function claimPortalSubmission(database, manifest, runnerId) {
  const { submission } = await database('portal-submission-claim', { manifest, runnerId });
  if (!submission) throw new Error('database did not return a portal submission claim');
  return {
    submission,
    claimed: submission.state === 'claimed' && submission.claimed_by === runnerId,
    noOp: TERMINAL_OR_POST_SUBMIT.has(submission.state),
  };
}

export async function transitionPortalSubmission(database, manifest, expectedState, nextState, result = {}, error = null) {
  const response = await database('portal-submission-transition', {
    idempotencyKey: manifest.idempotencyKey,
    expectedState,
    nextState,
    result,
    error: error ? String(error.message ?? error) : null,
  });
  return response.submission;
}
