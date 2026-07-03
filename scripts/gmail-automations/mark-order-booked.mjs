// Scans Gmail for genuine PLT DC booking-confirmation emails under the
// "Bookings" label, marks the matching orders Booked via the
// mark-order-booked edge function, and creates a Google Calendar dispatch
// reminder for each PO (the day before the confirmed delivery date).
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
  createCalendarEvent,
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

The thread carries a broad "Bookings" label used for all booking-related correspondence with PrettyLittleThing — most threads under it are NOT genuine DC delivery confirmations (many are the human's own outgoing booking requests, buyer status chases, approval discussions, etc). A genuine confirmation comes from a DC booking system (sender like "uk2dcbookings@boohoo.com") and contains a plain-text/HTML table dump with, per row: a supplier name, department, one or two dates, an email address, various codes, a PO number, a style/reference number, a SECOND date paired immediately with a delivery TIME (e.g. "11:00") — this date+time pairing is the CONFIRMED delivery slot — and a booking/consignment reference code near the end of the row (e.g. "EBUK20507-20"). The email may separately mention a delivery address (e.g. under a heading like "Sheffield Address:"). One PO can appear in multiple rows with different style values — these are multiple styles under the SAME appointment if they share the same date/time/reference.

Reply with ONLY a JSON object, no other text, matching this shape:
{
  "genuine": boolean,
  "bookings": [
    {
      "po": "0070044032",
      "styles": ["CNQ4618"],
      "confirmed_date": "2026-07-05",
      "confirmed_time": "11:00",
      "reference": "EBUK20507-20",
      "delivery_address": "Pretty Little Thing, Shepcote Lane, Sheffield, S9 1RF"
    }
  ]
}

Rules:
- "po" must be a 10-digit zero-padded numeric string. Left-pad if the email shows fewer digits (e.g. "70044032" -> "0070044032").
- "confirmed_date" must be ISO YYYY-MM-DD, converted from whatever format the email uses (e.g. "Sun 05-Jul-26" -> "2026-07-05"). Get the year right — these emails don't always spell it out in full.
- "delivery_address" is null if no address is mentioned anywhere in the body.
- Group rows into one "bookings" entry per unique (po, confirmed_date, confirmed_time, reference) combination, merging their styles into one array.
- If genuine is false, "bookings" must be an empty array.
- Never invent a PO, date, time, reference, or address that is not actually present in the text. If you are unsure about any field for a row, drop that row rather than guessing.`;

function addDaysUTC(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

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
      maxTokens: 2048,
    });
  } catch (err) {
    console.error(`  judgment failed for thread ${thread.id}: ${err.message}`);
    // A failed judgment call (API error, rate limit, billing, etc.) is not
    // the same as the model deciding the thread isn't genuine — leave it
    // completely unlabeled so it's retried next run, same as an edge
    // function failure below. Never label on a caught exception here.
    return { failed: true, genuine: null, booked: 0, events: 0 };
  }

  if (!result.genuine || !result.bookings?.length) {
    await modifyThreadLabels(accessToken, thread.id, { add: [LABEL.NEEDS_REVIEW] });
    return { failed: false, genuine: false, booked: 0, events: 0 };
  }

  let anyFailed = false;
  let anyNeedsReview = false;
  let booked = 0;
  let events = 0;

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
      continue; // nothing booked, no calendar event either
    }
    if (skipped.length > 0) anyNeedsReview = true;
    booked += matched;

    try {
      const dispatchDate = addDaysUTC(booking.confirmed_date, -1);
      await createCalendarEvent(accessToken, {
        summary: `Dispatch: PO ${booking.po} — DC delivery ${booking.confirmed_date}, ${booking.confirmed_time}`,
        description: [
          `Confirmed delivery: ${booking.confirmed_date} ${booking.confirmed_time}`,
          booking.delivery_address ? `Address: ${booking.delivery_address}` : null,
          booking.reference ? `Reference: ${booking.reference}` : null,
          booking.styles?.length ? `Styles: ${booking.styles.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        location: booking.delivery_address ?? undefined,
        start: { date: dispatchDate },
        end: { date: addDaysUTC(dispatchDate, 1) },
      });
      events++;
    } catch (err) {
      console.error(`  calendar event creation failed for PO ${booking.po}: ${err.message}`);
      anyNeedsReview = true;
    }
  }

  if (anyFailed) {
    // Leave unlabeled so this thread is retried next run.
    return { failed: true, genuine: true, booked, events };
  }

  const labelsToAdd = [LABEL.PROCESSED];
  if (anyNeedsReview) labelsToAdd.push(LABEL.NEEDS_REVIEW);
  await modifyThreadLabels(accessToken, thread.id, { add: labelsToAdd });
  return { failed: false, genuine: true, booked, events };
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
  let totalBooked = 0;
  let totalEvents = 0;
  let failed = 0;

  for (const thread of threads) {
    console.log(`Processing thread ${thread.id}...`);
    const result = await processThread(accessToken, apiKey, thread);
    if (result.failed) {
      failed++;
    } else if (!result.genuine) {
      flaggedNotConfirmation++;
    } else {
      genuine++;
    }
    totalBooked += result.booked;
    totalEvents += result.events;
  }

  console.log('');
  console.log('Summary:');
  console.log(`  Threads found: ${threads.length}`);
  console.log(`  Genuine booking confirmations: ${genuine}`);
  console.log(`  Flagged Needs Review (not a confirmation): ${flaggedNotConfirmation}`);
  console.log(`  Orders booked: ${totalBooked}`);
  console.log(`  Calendar events created: ${totalEvents}`);
  console.log(`  Failed / judgment errors (left unlabeled for retry next run): ${failed}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
