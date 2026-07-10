// Scans Gmail for PLT "production samples approved" emails and marks the
// matching orders sample_approved via the mark-sample-approved edge function.
// Runs hourly from .github/workflows/gmail-automations.yml on a normal
// GitHub-hosted runner (full internet access — this replaces an earlier
// attempt to run this as a Claude Code cloud routine, which could not reach
// supabase.co from its sandboxed egress proxy).
//
// Label IDs are hardcoded rather than looked up each run: they're stable for
// a given Gmail account and this avoids an extra API call per run. Verified
// against this account's actual labels before hardcoding.
import {
  getAccessToken,
  searchThreads,
  getThread,
  modifyThreadLabels,
  extractPlainTextBody,
  getHeader,
} from './lib/google.mjs';
import { extractJson } from './lib/claude.mjs';

const LABEL = {
  SAMPLE_APPROVAL: 'Label_8557302935933059274',
  PROCESSED: 'Label_1',
  NEEDS_REVIEW: 'Label_2',
};

const SEARCH_QUERY =
  'label:Sample-Approval -label:Sample-Approval-Processed -label:Sample-Approval-Needs-Review';

// georgia.matulka's team sends approvals as "PROCEED WITH BOOKING" emails
// straight to the inbox instead of the hand-labeled correspondence the main
// query expects — label them automatically so they enter the normal flow.
// Kept sender-scoped and recent; the LLM judgment downstream still decides
// whether each thread is a genuine approval, so a loose match here costs at
// most a Needs-Review flag, never a false approval.
const AUTO_LABEL_QUERY =
  'from:georgia.matulka@prettylittlething.com {subject:(proceed booking) "sample approval"} ' +
  '-label:Sample-Approval newer_than:30d';

const SUPABASE_FUNCTIONS_URL =
  process.env.SUPABASE_FUNCTIONS_URL ?? 'https://sfwnmddlmiprvsoxbatz.supabase.co/functions/v1';
const DRY_RUN = process.env.DRY_RUN === '1';

const SYSTEM_PROMPT = `You judge and extract data from a single email thread for Denovo Apparel's order tracker.

The thread may or may not be a genuine "production samples approved" notification from a buying team (typically PrettyLittleThing). Genuine ones contain language like "the below production samples are approved" plus a table with columns including PO / Style / Description. A PO can appear multiple times with different Style values — each row is a separate approval pair, not a duplicate.

Reply with ONLY a JSON object, no other text, matching this shape:
{
  "genuine": boolean,
  "pairs": [ { "po": "0070044193", "style_no": "CNQ4764" } ]
}

Rules:
- "po" must be a 10-digit zero-padded numeric string. Left-pad if the email shows fewer digits (e.g. "70044193" -> "0070044193").
- "style_no" is omitted from a pair entirely if the row has no style value (do not invent one, do not use an empty string).
- If genuine is false (e.g. it's actually about freight bookings, invoices, or something unrelated that got mislabeled), "pairs" must be an empty array.
- Never invent a PO or style that is not actually present in the text. If you are unsure about a value, omit that pair rather than guessing.`;

async function processThread(accessToken, apiKey, thread) {
  const full = await getThread(accessToken, thread.id);
  const latest = full.messages[full.messages.length - 1];
  const body = extractPlainTextBody(latest);
  const subject = getHeader(latest, 'Subject');
  const from = getHeader(latest, 'From');

  let result;
  try {
    result = await extractJson({
      apiKey,
      system: SYSTEM_PROMPT,
      prompt: `From: ${from}\nSubject: ${subject}\n\nBody:\n${body}`,
    });
  } catch (err) {
    console.error(`  judgment failed for thread ${thread.id}: ${err.message}`);
    // A failed judgment call (API error, rate limit, billing, etc.) is not
    // the same as the model deciding the email isn't genuine — leave it
    // completely unlabeled so it's retried next run, same as an edge
    // function failure below. Never label on a caught exception here.
    return { needsReview: false, failed: true, genuine: null };
  }

  if (!result.genuine || !result.pairs?.length) {
    await modifyThreadLabels(accessToken, thread.id, { add: [LABEL.NEEDS_REVIEW] });
    return { needsReview: true, failed: false, genuine: result.genuine };
  }

  let anyUnmatched = false;
  let anyFailed = false;

  for (const pair of result.pairs) {
    const payload = { po: pair.po };
    if (pair.style_no) payload.style_no = pair.style_no;

    try {
      if (DRY_RUN) {
        console.log(`[dry-run] mark sample approved: ${JSON.stringify(payload)}`);
        continue;
      }
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/mark-sample-approved`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-automation-secret': process.env.SAMPLE_APPROVAL_SECRET,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      if ((json.matched ?? 0) === 0) anyUnmatched = true;
    } catch (err) {
      console.error(`  edge function call failed for PO ${pair.po}: ${err.message}`);
      anyFailed = true;
    }
  }

  if (anyFailed) {
    // Leave unlabeled so this thread is retried next run.
    return { needsReview: false, failed: true };
  }

  const labelsToAdd = [LABEL.PROCESSED];
  if (anyUnmatched) labelsToAdd.push(LABEL.NEEDS_REVIEW);
  await modifyThreadLabels(accessToken, thread.id, { add: labelsToAdd });
  return { needsReview: anyUnmatched, failed: false };
}

async function main() {
  const accessToken = await getAccessToken({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
  });
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const autoLabelThreads = await searchThreads(accessToken, AUTO_LABEL_QUERY);
  for (const thread of autoLabelThreads) {
    await modifyThreadLabels(accessToken, thread.id, { add: [LABEL.SAMPLE_APPROVAL] });
  }
  if (autoLabelThreads.length > 0) {
    console.log(`Auto-labeled ${autoLabelThreads.length} thread(s) as Sample-Approval.`);
  }

  const threads = await searchThreads(accessToken, SEARCH_QUERY);
  console.log(`Found ${threads.length} unprocessed Sample Approval thread(s).`);

  let genuine = 0;
  let flaggedNotApproval = 0;
  let flaggedUnmatched = 0;
  let failed = 0;

  for (const thread of threads) {
    console.log(`Processing thread ${thread.id}...`);
    const result = await processThread(accessToken, apiKey, thread);
    if (result.failed) failed++;
    else if (result.genuine === false) flaggedNotApproval++;
    else {
      genuine++;
      if (result.needsReview) flaggedUnmatched++;
    }
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Threads found: ${threads.length}`);
  console.log(`  Genuine approvals processed: ${genuine} (of which ${flaggedUnmatched} had an unmatched pair -> Needs Review)`);
  console.log(`  Flagged Needs Review (not a genuine approval): ${flaggedNotApproval}`);
  console.log(`  Failed (left for retry next run): ${failed}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
