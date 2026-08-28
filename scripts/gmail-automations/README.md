# Gmail automations (GitHub Actions)

Six automations, one workflow (`.github/workflows/gmail-automations.yml`).
The Gmail/Supabase job runs hourly on a GitHub-hosted Ubuntu runner; Portal
browser work is routed to the separate self-hosted Windows runner so it can
use installed Chrome in headed mode:

- `mark-sample-approved.mjs` / `mark-order-booked.mjs` — read
  `denovogb@gmail.com`, use Claude (Haiku) to judge/extract data from
  labeled threads, call a Supabase edge function.
- `generate-docket.mjs` — reads **`denovosourcing@gmail.com`** for incoming
  PO emails (CSV of order rows + PDF PO confirmation), and automates the
  "Generate Dockets & Import Orders" button in `web/index.html`: no LLM step,
  writes to Supabase directly with a service-role key and retains the original
  buyer CSV by PO for shipment-time Portal carton uploads. Its `Docket-Processed`
  / `Docket-Needs-Review` labels are created automatically by the script on
  first run — unlike `Sample-Approval` / `Bookings`, there's no manual
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
