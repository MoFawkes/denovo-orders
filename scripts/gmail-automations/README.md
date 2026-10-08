# Gmail automations (GitHub Actions)

Seven automations, one workflow (`.github/workflows/gmail-automations.yml`).
The Gmail/Supabase job runs hourly on a GitHub-hosted Ubuntu runner; Portal
browser work is routed to the separate self-hosted Windows runner so it can
use installed Chrome in headed mode:

- `import-sample-approval-csv.mjs` — reads buyer OPO chase CSV attachments in
  `denovogb@gmail.com` and approves matching PO/buyer-style pairs from explicit
  Yes values. This replaces the retired LLM-based sample approval email reader.
- `mark-order-booked.mjs` — reads `denovogb@gmail.com`, uses Claude (Haiku)
  to extract booking data from labeled threads, and calls a Supabase edge function.
- `generate-docket.mjs` — reads **`denovosourcing@gmail.com`** for incoming
  PO emails (CSV of order rows + PDF PO confirmation), and automates the
  "Generate Dockets & Import Orders" button in `web/index.html`: no LLM step,
  writes to Supabase directly with a service-role key and retains the original
  buyer CSV by PO for shipment-time Portal carton uploads. Its `Docket-Processed`
  / `Docket-Needs-Review` labels are created automatically by the script on
  first run — unlike `Bookings`, there's no manual
  labeling step to set up.
- `complete-order-from-packing-list.mjs` — retains compatibility with older
  Denovo Drive packing lists. New Portal-only deliveries do not create these
  legacy sheets.
- `draft-packing-list.mjs` — reads WhatsApp photos of handwritten docket
  sheets forwarded to `denovogb@gmail.com` and labelled **`Packing List`**.
  It validates carton quantities, matches PO + SKU, and checks Sample Approved.
  Unapproved orders wait under **`Packing List/Awaiting Sample Approval`**
  without consuming an invoice, then resume automatically after approval. A
  booking is optional. If none exists, the automation leaves the dispatch
  date blank, atomically assigns the next invoice number (initially 256),
  combines the retained buyer CSV with the packed cartons, attaches the Portal
  upload CSV, creates the Portal handoff, and marks the thread Processed. If
  the retained CSV is unavailable or invalid, it requests the original CSV in
  the Gmail thread and resumes automatically when the attachment is supplied.
- `portal-automation.mjs` — runs immediately after drafting in the same
  workflow, drives the buyer ISC Portal, submits cartons once, validates the
  BEL PDF, downloads the Portal's official packing list, stamps its Invoice
  Serial Number and dispatch date, then replies with both files. Any failure
  after Submit becomes `uncertain-after-submit` and is never retried.
- `send-plt-invoices.mjs` — once an order's booking task is completed
  (`INV <n> — ...`) and its booked delivery time has passed, builds the
  invoice PDF, adds it to the PLT statement sheet and saves a Gmail draft in
  `denovosourcing@gmail.com` for PLT. See [PLT invoices and statement](#plt-invoices-and-statement).

## Current rollout status (27 August 2026)

- Linux CI and Gmail/Supabase jobs use GitHub-hosted Ubuntu runners. The
  Windows Portal runner (`denovo-portal-windows`) remains self-hosted and
  targets the `denovo-portal` label.
- Gmail drafting, automatic sequential invoice allocation, optional bookings,
  sample-approval limbo, and Portal handoff generation are implemented. Portal
  submission remains disabled for scheduled runs.
- Headed Chrome bypasses the AWS ALB 403 that blocked Linux/headless runs.
  Automated username/password and TOTP authentication completes, including
  Cognito's delayed **Sign in as** confirmation.
- The remaining blocker is the ISC Portal authentication callback: it returns
  HTTP 401 after Cognito confirmation and starts a new sign-in loop. Navigating
  to `https://isc-portal.debenhamsgroup.com` first, as advised by Debenhams,
  was tested and produces the same result. No live Portal submission has been
  completed from the runner.
- Recovery case PO `0070065988` is reserved as invoice `256` with a validated
  26-carton handoff preserved outside Git. It has not been submitted, so a
  future recovery must reuse invoice 256 rather than allocate another number.
- Debenhams confirmed there is no direct API for uploading carton details;
  CSV upload through the Portal is the closest supported route. The remaining
  external dependency is therefore resolution of the callback 401. After
  access is restored, rerun `navigate-only`, then use protected `submit-one`
  for PO `0070065988`.

## One-time setup

### 1. Create a Google Cloud OAuth client

1. Go to https://console.cloud.google.com/ and create a project (or reuse one).
2. Enable the **Gmail API**, **Google Tasks API** and **Google Drive API**
   (APIs & Services > Library).
3. Configure the **OAuth consent screen** (APIs & Services > OAuth consent
   screen): External, then **Publish app** so the publishing status is
   **In production** — do NOT leave it in Testing mode. Testing-mode
   external apps get refresh tokens that Google expires after **7 days**
   (this took the docket automation down on 2026-07-16), which defeats the
   whole setup. Don't submit for verification: unverified is fine for our
   two accounts; the only effect is an "unverified app" warning during the
   sign-in in step 2 (click Advanced > Go to app). The client is shared
   across both mailboxes (it identifies the app, not the mailbox; the
   mailbox binding only happens when you sign in during step 2).
4. Create credentials (APIs & Services > Credentials > Create Credentials >
   OAuth client ID) of type **Desktop app**. Note the Client ID and Client
   Secret — you'll need them in the next step and to add as GitHub secrets.

### 2. Get a refresh token per mailbox (run this yourself, not through Claude)

A refresh token is a long-lived credential with Gmail + Tasks + Drive
(read-only, plus write access to the app's own uploads via `drive.file`)
access for whichever account you sign in as — run this locally
so it never appears in a chat transcript. You need **one refresh token per
mailbox** (two runs of the same script, signing in as a different account
each time). Tokens issued before a scope was added to this script lack that
scope — e.g. a `denovogb` token from before the packing-list automation has
no `drive.readonly`, so Drive calls 403 until you re-run this and update
the secret:

```powershell
$env:GMAIL_OAUTH_CLIENT_ID = "<client id from step 1>"
$env:GMAIL_OAUTH_CLIENT_SECRET = "<client secret from step 1>"
node scripts/gmail-automations/oauth-setup.mjs
```

Open the printed URL and sign in as `denovogb@gmail.com` for the first
token, then run it again and sign in as `denovosourcing@gmail.com` for the
second. Each run prints a refresh token — copy it immediately, it's only
shown once (you can always re-run to get a new one if needed).

### 3. Add GitHub repository secrets

Settings > Secrets and variables > Actions > New repository secret, for each of:

| Secret name | Value |
|---|---|
| `GMAIL_OAUTH_CLIENT_ID` | from step 1 |
| `GMAIL_OAUTH_CLIENT_SECRET` | from step 1 |
| `GMAIL_OAUTH_REFRESH_TOKEN` | from step 2, signed in as `denovogb@gmail.com` |
| `GMAIL_SOURCING_OAUTH_REFRESH_TOKEN` | from step 2, signed in as `denovosourcing@gmail.com` |
| `ANTHROPIC_API_KEY` | an Anthropic API key (console.anthropic.com) |
| `SAMPLE_APPROVAL_SECRET` | must match the `SAMPLE_APPROVAL_SECRET` env var already set on the `mark-sample-approved` Supabase edge function |
| `BOOKING_AUTOMATION_SECRET` | must match the `BOOKING_AUTOMATION_SECRET` env var already set on the `mark-order-booked` Supabase edge function |
| `SUPABASE_SERVICE_ROLE_KEY` | from the Supabase dashboard: Project Settings > API > `service_role` secret key. Bypasses RLS entirely (same as the two automation secrets above, but for the whole database, not one edge function) — treat it like a DB superuser password, not a normal API key |
| `PORTAL_USERNAME` | ISC Portal email (`denovogb@gmail.com`) |
| `PORTAL_PASSWORD` | ISC Portal password |
| `PORTAL_TOTP_SECRET` | Base32 authenticator seed, not a current six-digit code |

Create a GitHub environment named **`portal-submission`** with required
reviewers before using `submit-one` or the default `submit-fresh` mode. Leave the repository variable
`PORTAL_SCHEDULED_ENABLED` absent or `0` during rollout; set it to `1` only
after the duplicate/no-op and crash-after-submit exercises are signed off.

The sample-approval/booking secrets are existing shared secrets already
configured on the Supabase edge functions (previously only known to the
now-paused Claude Code routines) — reuse the same values so no edge function
redeploy is needed.

### 4. Test it

Actions tab > "Gmail automations" workflow > Run workflow (uses
`workflow_dispatch`, no need to wait for the hourly cron). Check the run logs
for the summary line each script prints at the end.

For a manual run, leave **invoice_start** blank to continue the stored sequence. To carry on from a specific higher number, enter that number; it becomes the next invoice assigned, and later dockets continue upward automatically.

For a read-only production rehearsal, enable the **dry_run** input. The jobs
still read real Gmail, Drive, Tasks, and Supabase data, but every label, reply,
task, upload, edge-function mutation, database mutation, and checkpoint write
is replaced by a `[dry-run]` log line.

Portal rollout is deliberately separate from `dry_run`: `validate-config`
does not open a browser; `login-smoke` stops after MFA; `navigate-only` opens
the PO without changing it; `submit-one` requires an exact PO, and the default `submit-fresh` processes handoffs created in the current run; both require approval
through the protected environment. Use the read-only modes before enabling submission. Scheduled Portal
submission stays disabled unless `PORTAL_SCHEDULED_ENABLED=1`.

## Ongoing

Runs hourly via cron (`13 * * * *`, UTC) automatically once the secrets above
are in place. No further action needed.

If a job fails with `invalid_grant: Token has been expired or revoked`,
re-run step 2 for that mailbox and update the matching secret
(`GMAIL_OAUTH_REFRESH_TOKEN` for `denovogb`, `GMAIL_SOURCING_OAUTH_REFRESH_TOKEN`
for `denovosourcing`). Causes, most likely first:

- The consent screen slipped back to (or never left) **Testing** publishing
  status — Testing-mode refresh tokens expire after 7 days, and tokens
  minted *while* in Testing keep that 7-day expiry even after the app is
  published. Publish to production (step 1.3), then re-mint **both** tokens.
- The account password was changed, or access was revoked from the
  account's Security > Third-party access page.
- ~6 months of complete inactivity (won't happen while the hourly cron is
  running).

## Retry safety and recovery

`draft-packing-list` and `complete-order-from-packing-list` write durable
checkpoints to `public.automation_executions`. The table is protected by RLS
with no browser-client policies; only the service-role automation can access
it.

Portal submissions use `public.portal_submissions`, a separate transaction
state machine. Safe pre-submit failures may be claimed again. Post-submit and
`uncertain-after-submit` records are automatic no-ops on rerun and require
human reconciliation through the Portal's Unsubmit/edit flow.

Checkpoint identities use the external source rather than an order row:

| Automation | Source | Steps |
|---|---|---|
| Packing-list drafting | Gmail thread ID | Docket summary, idempotent invoice allocation, Portal handoff confirmation |
| Packing-list completion | Drive file ID | Workbook parse attempts and last error |

If a run fails after an external side effect but before Gmail labels are
updated, rerun the workflow. A completed checkpoint lets the retry repair the
label without repeating the recorded reply or upload. Failed parse rows retain
`attempt_count` and `last_error` for diagnosis; a later successful parse clears
the error.

For a persistent failure:

1. Open the failed GitHub Actions job and identify the Gmail thread or Drive
   file ID in its log.
2. Inspect the matching `automation_executions` rows in Supabase.
3. Fix the input or credential problem. Do not delete a completed upload or
   reply checkpoint unless repeating that external action is intentional.
4. Use **Run workflow** to retry. Jobs return a non-zero exit code when work
   remains failed, so a green run means the retry backlog was cleared.

### Useful checkpoint queries

Run these in the Supabase SQL editor as an administrator. Always inspect a row
before changing it; deleting a completed checkpoint explicitly authorizes the
corresponding external action to happen again.

Find failures, oldest first:

```sql
select automation, source_id, step, attempt_count, last_error, last_attempted_at
from public.automation_executions
where status = 'failed'
order by last_attempted_at;
```

Find threads that have uploaded a file but have not recorded a confirmation:

```sql
select upload.source_id, upload.result ->> 'id' as drive_file_id,
       upload.last_attempted_at
from public.automation_executions upload
where upload.automation = 'draft-packing-list'
  and upload.step like 'drive-upload:%'
  and upload.status = 'completed'
  and not exists (
    select 1 from public.automation_executions confirmation
    where confirmation.automation = upload.automation
      and confirmation.source_id = upload.source_id
      and confirmation.step = replace(upload.step, 'drive-upload:', 'creation-confirmation-sent:')
      and confirmation.status = 'completed'
  );
```

Inspect every checkpoint for one Gmail thread or Drive file:

```sql
select * from public.automation_executions
where source_id = '<gmail-thread-id-or-drive-file-id>'
order by first_attempted_at;
```

Reset only the failed parse record for a Drive file, then rerun the workflow:

```sql
delete from public.automation_executions
where automation = 'complete-order-from-packing-list'
  and source_id = '<drive-file-id>'
  and step = 'parse'
  and status = 'failed';
```

Replay a generated file only after the existing Drive file has been removed or
confirmed unwanted. This deletes the upload and confirmation checkpoints; the
next run uploads and replies again:

```sql
delete from public.automation_executions
where automation = 'draft-packing-list'
  and source_id = '<gmail-thread-id>'
  and step in ('drive-upload:<invoice>', 'creation-confirmation-sent:<invoice>');
```

## OPO chase CSV sample approvals

The hourly Gmail job uses only `import-sample-approval-csv.mjs` against
`denovogb@gmail.com`. It automatically finds Lulu Marshall's Dresses OPO
Chase emails for Denovo Sourcing from 25 September 2026 onward, checks Gmail's
DKIM/DMARC result, and reads attached CSVs without an LLM or manual label.
Only explicit `Sage Sample Approved = Yes` rows approve orders, matching the
numeric PO (with or without leading zeros) and buyer `style`. No values never
revoke approvals; completed/cancelled orders are unchanged. Duplicate pairs
across the message's CSVs are skipped for review.

Each message receives `Sample-CSV-Processed` or `Sample-CSV-Needs-Review`.
New messages in an existing thread are processed independently. Remove the
review label after resolving unmatched orders to retry. Network/database
failures leave the message unprocessed and fail the workflow step for retry;
previous approvals are safe to repeat. Dry-run does not approve or label.
No replies are sent.

Deploy the updated `mark-sample-approved` edge function before enabling this
workflow revision. The CSV batch request fails safely on the older endpoint
rather than using its broader legacy matching rules. Uses the existing
`SAMPLE_APPROVAL_SECRET`; no new secrets or schema changes are required.

## PLT invoices and statement

`send-plt-invoices.mjs` runs hourly after packing-list steps. A completed
booking task titled `INV <n> — <description>` becomes eligible after its
booked delivery date/time passes in Europe/London. This is the chosen trigger,
not proof of physical delivery. Invoices below 274 are ignored by default.

For each eligible invoice, the automation:

1. Saves immutable invoice data in the existing `automation_executions`
   table before external writes. It creates an A4 invoice PDF using packed
   quantities, PPU, 20% VAT, booking reference and 45-day payment terms.
   The invoice date is the date first prepared and survives retries.
2. Adds its row to the shared PLT statement. Row insertion, cell values and
   formula updates commit in one atomic Sheets request. A retry verifies the
   existing invoice number, PO, amount and dates before recovering a row.
   Existing rows without an automation intent/checkpoint remain manual invoices.
3. Creates one Gmail **draft per invoice** in `denovosourcing@gmail.com`,
   addressed to Medius PLT Invoices UK and Jade Wynne, with the invoice and
   current statement PDF attached. **No emails are sent automatically.**
   All new invoice rows are written before the statement is exported.

Each run also ages the statement, even without new invoices, around Friday
remittance runs. Each dated invoice is assigned to the first Friday on or
after its contractual due date (Friday itself is included). **Due Soon** /
status **DUE** covers this week's Friday run; **Overdue** means its remittance
Friday has already passed without payment. Future runs remain **Not Yet Due**.
For example, on Thursday 8 October, invoices due 5–9 October are DUE;
invoices due by Friday 2 October are OVERDUE. Unpaid invoices from the
9 October run become OVERDUE on Saturday 10 October. The original 45-day
payment due date is unchanged. Whole-row moves preserve formatting and credit rows. Immediate-term
credits stay in their existing section. Rows marked `PAID` or `SETTLED` are
not moved and are excluded from outstanding totals. Payments/credit notes
still need recording by a person; the automation cannot infer them.

New Portal packing tasks carry an `Invoice lines:` JSON line with exact
per-SKU quantities, descriptions and unit prices in pence, supporting multiple
prices on one invoice. Legacy tasks with one PPU still work. For an older
multi-price task, add an explicit line such as:

```text
Invoice lines: [{"sku":"CNQ1","description":"Black Dress","quantity":100,"unitPricePence":800},{"sku":"CNQ2","description":"Cream Dress","quantity":99,"unitPricePence":950}]
```

The line quantities must equal `Packed qty (total)`. Missing prices,
quantities, box counts or booking dates, invalid dates, conflicting tasks or
invoices too large for the A4 template stop that invoice with a visible error.
Correct the completed task's notes or issue the invoice manually and add it
to the statement. No prices, quantities or delivery dates are guessed.
All completed tasks are scanned, so old unissued invoices do not expire from
a lookback window. No order schema, frontend changes or new Supabase grants
are needed.

### Permissions and activation

Merge this change into `main` before scheduled runs can use it. Leave
`PLT_INVOICES_ENABLED` unset until the preview succeeds.

1. In the existing Google Cloud project containing the OAuth client, enable
   **Google Sheets API** (APIs & Services > Library). Gmail API, Tasks API
   and Drive API must also be enabled; existing automations already use them.
2. Open the statement spreadsheet and share it with
   **denovosourcing@gmail.com as Editor**. If its ranges are protected,
   allow that account to edit them too. The account must be able to insert
   and move invoice rows and update the A:F table plus H:I summary.
3. Under Google Auth Platform > Data Access (or OAuth consent screen),
   add `https://www.googleapis.com/auth/spreadsheets` to the existing
   application's scopes. Sheets authorization applies to the whole file,
   not just the PLT tab. Keep the app's Audience publishing status
   **In production**; Testing refresh tokens with these scopes expire
   after seven days.
4. Re-authorize **only the sourcing mailbox** with the updated helper.
   Use the existing Desktop OAuth client ID/secret from Google Cloud >
   Credentials. In your own PowerShell terminal at the repository root:

   ```powershell
   $env:GMAIL_OAUTH_CLIENT_ID = Read-Host 'OAuth client ID'
   $env:GMAIL_OAUTH_CLIENT_SECRET = [System.Net.NetworkCredential]::new('', (Read-Host 'OAuth client secret' -AsSecureString)).Password
   node .\scripts\gmail-automations\oauth-setup.mjs
   Remove-Item Env:GMAIL_OAUTH_CLIENT_ID, Env:GMAIL_OAUTH_CLIENT_SECRET
   ```

   Open the printed URL, choose **denovosourcing@gmail.com**, and approve
   the requested access. The helper retains the existing Gmail/Tasks/Drive
   scopes and adds Sheets. The refresh token is printed only in your own
   terminal; do not paste it into chat or commit it.
5. At GitHub > repository Settings > Secrets and variables > Actions >
   Secrets, replace **GMAIL_SOURCING_OAUTH_REFRESH_TOKEN** with that token.
   If the existing value is an environment secret in **production**, replace
   it there instead (Settings > Environments > production > Environment
   secrets); environment secrets override repository secrets.
   The existing `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`,
   `GMAIL_OAUTH_REFRESH_TOKEN` (denovogb Tasks) and
   `PACKING_LIST_DB_SECRET` stay in use. No new Supabase secret is required.
6. In GitHub Actions > Gmail automations > Run workflow, choose this branch
   for a pre-merge check, or `main` after merging. Check **plt_invoice_preview**.
   This forces every Gmail automation to dry-run and skips the Portal job,
   regardless of the other inputs. It reads real Tasks/Sheets and logs the
   planned statement edits and drafts without saving rows, drafts or
   checkpoints. Its exported statement remains the live unchanged sheet;
   the preview does not validate the final combined statement PDF or prove
   write permission.
7. After the preview is clean and the change is merged, set repository
   variable **PLT_INVOICES_ENABLED = 1** under Actions > Variables.
   Run normally with **portal_mode = disabled** to process invoices without
   a Portal submission, or let the next hourly schedule run. Check the
   first invoice draft, statement row and PDF before sending it.

Optional repository variables (the workflow passes them through):

| Variable | Default |
| --- | --- |
| `PLT_FIRST_INVOICE` | `274` |
| `PLT_STATEMENT_SPREADSHEET_ID` | `1DK9ht3fSXRopjnkZyufVPVsZaKB1jqnOndVWeYHMOy4` |
| `PLT_STATEMENT_SHEET` | `PLT Statement` |

The existing sourcing token needs `gmail.modify` for drafts and recovery
searches, `drive.readonly` for the statement PDF export, and the new
`spreadsheets` scope for statement edits. The denovogb token's existing
Tasks access is sufficient; it does not need re-authorization for this change.

### Recovery

Checkpoints use automation `plt-invoice`, source ID = invoice number:

- `prepared`: immutable invoice inputs/date saved before the first Sheets write.
- `statement-row`: row confirmed; a missing checkpoint is repaired from the
  saved intent and verified live row.
- `draft-started`: intent saved immediately before Gmail draft creation.
- `draft-created`: draft saved or existing draft/sent email recovered.

Each email has a stable Message-ID
`denovo-plt-invoice-<number>@denovosourcing.com`. If creation times out or its
final checkpoint fails, the next run searches Gmail (including Bin) for
that identifier. Existing Draft/Sent emails are recovered; an ambiguous or
deleted email is never blindly recreated. A very brief Gmail search-index
delay can therefore require a later run before recovery.

If `draft-started` exists but no email is found, check Drafts, Sent and Bin
in the sourcing mailbox (search
`in:anywhere rfc822msgid:denovo-plt-invoice-274@denovosourcing.com`).
Only after confirming no draft/email exists, reset that invoice's
`draft-started` checkpoint via the Supabase SQL editor:

```sql
delete from public.automation_executions
where automation = 'plt-invoice' and source_id = '<invoice>'
  and step = 'draft-started';
```

To deliberately replace a deleted unsent draft, first verify it was never
sent and remove the old draft from Bin, then delete both `draft-started`
and `draft-created` for that invoice. Keep `prepared` and `statement-row`;
the invoice date and statement row must not change. Never reset these
checkpoints for an already sent invoice.

A PO/amount/date mismatch in a recovered statement row requires manual
reconciliation rather than overwriting financial records. Original Claude
runs that wrote a row but no checkpoint/intent cannot be distinguished from
manual invoices; reconcile those individually before retrying.
