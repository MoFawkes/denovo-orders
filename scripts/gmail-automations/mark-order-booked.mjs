// Scans Gmail for genuine PLT DC booking-confirmation emails under the
// "Bookings" label, marks the matching orders Booked via the
// mark-order-booked edge function, and creates one Google Task per PO/
// appointment (combining every colourway dispatching under that booking
// into a single checkable to-do), due the day before the confirmed
// delivery date.
//
// "Bookings" is a broad label the human applies to ALL booking-related
// correspondence with PrettyLittleThing, not just genuine DC confirmations —
// it also catches outgoing booking requests, buyer status chases, etc.
// Expect a good fraction of threads under this label to be flagged Needs
// Review because they aren't actually confirmations; that's normal filtering,
// not a bug.
import {
  getAccessToken,
  searchThreads,
  getThread,
  modifyThreadLabels,
  extractPlainTextBody,
  getHeader,
  createTask,
} from './lib/google.mjs';
import { extractJson } from './lib/claude.mjs';

const LABEL = {
  BOOKINGS: 'Label_4206137110983180361',
  PROCESSED: 'Label_6',
  NEEDS_REVIEW: 'Label_7',
};

const SEARCH_QUERY = 'label:Bookings -label:Bookings-Processed -label:Bookings-Needs-Review';

const SUPABASE_FUNCTIONS_URL =
  process.env.SUPABASE_FUNCTIONS_URL ?? 'https://sfwnmddlmiprvsoxbatz.supabase.co/functions/v1';

const SYSTEM_PROMPT = `You judge and extract data from a single email thread for Denovo Apparel's order tracker.

The thread carries a broad "Bookings" label used for all booking-related correspondence with PrettyLittleThing — most threads under it are NOT genuine DC delivery confirmations (many are the human's own outgoing booking requests, buyer status chases, approval discussions, etc). A genuine confirmation comes from a DC booking system (sender like "uk2dcbookings@boohoo.com") and contains a plain-text/HTML table dump with, per row: a supplier name, department, one or two dates, an email address, various codes, a PO number, a style/reference number, a SECOND date paired immediately with a delivery TIME (e.g. "11:00") — this date+time pairing is the CONFIRMED delivery slot — and a booking/consignment reference code near the end of the row (e.g. "EBUK20507-20"). One PO can appear in multiple rows with different style values — these are multiple styles under the SAME appointment if they share the same date/time/reference.

Reply with ONLY a JSON object, no other text, matching this shape:
{
  "genuine": boolean,
  "bookings": [
    {
      "po": "0070044032",
      "styles": ["CNQ4618"],
      "confirmed_date": "2026-07-05",
      "confirmed_time": "11:00",
      "reference": "EBUK20507-20"
    }
  ]
}

Rules:
- "po" must be a 10-digit zero-padded numeric string. Left-pad if the email shows fewer digits (e.g. "70044032" -> "0070044032").
- "confirmed_date" must be ISO YYYY-MM-DD, converted from whatever format the email uses (e.g. "Sun 05-Jul-26" -> "2026-07-05"). Get the year right — these emails don't always spell it out in full.
- Group rows into one "bookings" entry per unique (po, confirmed_date, confirmed_time, reference) combination, merging their styles into one array.
- If genuine is false, "bookings" must be an empty array.
- Never invent a PO, date, time, or reference that is not actually present in the text. If you are unsure about any field for a row, drop that row rather than guessing.`;

function addDaysUTC(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'YYYY-MM-DD' + 'HH:MM' -> 'Sun 05-Jul-26 11:00'
function formatConfirmedDateTime(isoDate, time) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const weekday = WEEKDAYS[d.getUTCDay()];
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = MONTHS[d.getUTCMonth()];
  const year = String(d.getUTCFullYear()).slice(-2);
  return `${weekday} ${day}-${month}-${year} ${time}`;
}

// DB POs are 10-digit zero-padded; display them as they appear in the
// source email instead (e.g. '0070044193' -> '70044193').
function unpadPO(po) {
  return po.replace(/^0+(?=\d)/, '');
}

function titleCase(word) {
  if (!word) return '';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// description is "<Colour> <garment name>" (e.g. 'Black Stretch Woven Key
// Hole Bodycon Dress') -- strip the leading colour word so it can be
// recombined with other colourways sharing the same appointment.
function stripColourPrefix(description, colour) {
  if (!description) return '';
  if (!colour) return description.trim();
  return description.replace(new RegExp(`^${colour}\\s+`, 'i'), '').trim();
}

// The "Bookings" label goes back to 2021. Anything older than this is
// certainly for an order that's long since Completed (or Cancelled) --
// mark-order-booked would just skip it anyway -- so there's no reason to
// spend an LLM call judging it. Bulk-mark it Processed instead, for free.
const OLD_THREAD_CUTOFF = new Date('2026-04-03T00:00:00Z');

async function processThread(accessToken, apiKey, thread) {
  const full = await getThread(accessToken, thread.id);
  const latest = full.messages[full.messages.length - 1];

  const messageDate = latest.internalDate ? new Date(Number(latest.internalDate)) : null;
  if (messageDate && messageDate < OLD_THREAD_CUTOFF) {
    await modifyThreadLabels(accessToken, thread.id, { add: [LABEL.PROCESSED] });
    return { failed: false, genuine: null, booked: 0, tasks: 0, skippedOld: true };
  }

  const body = extractPlainTextBody(latest);
  const subject = getHeader(latest, 'Subject');
  const from = getHeader(latest, 'From');

  let result;
  try {
    result = await extractJson({
      apiKey,
      system: SYSTEM_PROMPT,
      prompt: `From: ${from}\nSubject: ${subject}\n\nBody:\n${body}`,
      maxTokens: 2048,
    });
  } catch (err) {
    console.error(`  judgment failed for thread ${thread.id}: ${err.message}`);
    // A failed judgment call (API error, rate limit, billing, etc.) is not
    // the same as the model deciding the thread isn't genuine — leave it
    // completely unlabeled so it's retried next run, same as an edge
    // function failure below. Never label on a caught exception here.
    return { failed: true, genuine: null, booked: 0, tasks: 0 };
  }

  if (!result.genuine || !result.bookings?.length) {
    await modifyThreadLabels(accessToken, thread.id, { add: [LABEL.NEEDS_REVIEW] });
    return { failed: false, genuine: false, booked: 0, tasks: 0 };
  }

  let anyFailed = false;
  let anyNeedsReview = false;
  let booked = 0;
  let tasks = 0;

  for (const booking of result.bookings) {
    let apiResult;
    try {
      const res = await fetch(`${SUPABASE_FUNCTIONS_URL}/mark-order-booked`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-automation-secret': process.env.BOOKING_AUTOMATION_SECRET,
        },
        body: JSON.stringify({ po: booking.po }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      apiResult = await res.json();
    } catch (err) {
      console.error(`  edge function call failed for PO ${booking.po}: ${err.message}`);
      anyFailed = true;
      continue;
    }

    const matched = apiResult.matched ?? 0;
    const skipped = apiResult.skipped ?? [];
    if (matched === 0) {
      anyNeedsReview = true;
      continue; // nothing booked, no task either
    }
    if (skipped.length > 0) anyNeedsReview = true;
    booked += matched;

    // One task per PO/appointment, combining every colourway dispatching
    // under this booking (mark-order-booked matches by PO, so apiResult.orders
    // already holds every style booked for this specific date/time/reference).
    const dispatchDate = addDaysUTC(booking.confirmed_date, -1);
    const matchedOrders = apiResult.orders ?? [];
    if (matchedOrders.length > 0) {
      const colours = [];
      for (const order of matchedOrders) {
        const label = titleCase(order.colour);
        if (label && !colours.includes(label)) colours.push(label);
      }
      const baseText = stripColourPrefix(matchedOrders[0].description, matchedOrders[0].colour);
      const title = colours.length > 0 ? `${colours.join('/')} ${baseText}`.trim() : baseText || `PO ${booking.po}`;
      const skus = matchedOrders.map((o) => o.style).filter(Boolean).join('/');
      const notes = [
        unpadPO(booking.po),
        skus,
        formatConfirmedDateTime(booking.confirmed_date, booking.confirmed_time),
        booking.reference,
      ]
        .filter(Boolean)
        .join('\n');

      try {
        await createTask(accessToken, { title, notes, dueDate: dispatchDate });
        tasks++;
      } catch (err) {
        console.error(`  task creation failed for PO ${booking.po}: ${err.message}`);
        anyNeedsReview = true;
      }
    }
  }

  if (anyFailed) {
    // Leave unlabeled so this thread is retried next run.
    return { failed: true, genuine: true, booked, tasks };
  }

  const labelsToAdd = [LABEL.PROCESSED];
  if (anyNeedsReview) labelsToAdd.push(LABEL.NEEDS_REVIEW);
  await modifyThreadLabels(accessToken, thread.id, { add: labelsToAdd });
  return { failed: false, genuine: true, booked, tasks };
}

async function main() {
  const accessToken = await getAccessToken({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN,
  });
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const threads = await searchThreads(accessToken, SEARCH_QUERY);
  console.log(`Found ${threads.length} unprocessed Bookings thread(s).`);

  let genuine = 0;
  let flaggedNotConfirmation = 0;
  let skippedOld = 0;
  let totalBooked = 0;
  let totalTasks = 0;
  let failed = 0;

  for (const thread of threads) {
    console.log(`Processing thread ${thread.id}...`);
    const result = await processThread(accessToken, apiKey, thread);
    if (result.skippedOld) {
      skippedOld++;
    } else if (result.failed) {
      failed++;
    } else if (!result.genuine) {
      flaggedNotConfirmation++;
    } else {
      genuine++;
    }
    totalBooked += result.booked;
    totalTasks += result.tasks;
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Threads found: ${threads.length}`);
  console.log(`  Skipped as too old (>3 months, marked Processed with no LLM call): ${skippedOld}`);
  console.log(`  Genuine booking confirmations: ${genuine}`);
  console.log(`  Flagged Needs Review (not a confirmation): ${flaggedNotConfirmation}`);
  console.log(`  Orders booked: ${totalBooked}`);
  console.log(`  Tasks created: ${totalTasks}`);
  console.log(`  Failed / judgment errors (left unlabeled for retry next run): ${failed}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
