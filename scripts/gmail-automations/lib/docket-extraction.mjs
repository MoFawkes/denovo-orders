import { validateDocket } from './domain.mjs';

export function docketExtractionProblems(result) {
  const dockets = result?.dockets ?? [];
  const problems = [];
  for (const docket of dockets) {
    const problem = validateDocket(docket);
    if (problem) problems.push(`docket #${docket.docket_no ?? '?'}: ${problem}`);
  }
  if (dockets.length === 0) problems.push('no docket sheets recognised in the photo(s)');
  const uniquePos = [...new Set(dockets.map((docket) => docket.po))];
  if (uniquePos.length > 1) {
    problems.push(`photos span ${uniquePos.length} different POs — send one PO per email`);
  }
  return problems;
}

export function needsQuantityRetry(problems) {
  return problems.some((problem) => /carton quantities add up|cartons read but the written box count|small-box carton/i.test(problem));
}

export function selectBetterExtraction(first, retry) {
  return docketExtractionProblems(retry).length < docketExtractionProblems(first).length ? retry : first;
}
