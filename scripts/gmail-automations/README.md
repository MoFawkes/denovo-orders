# Gmail automations (GitHub Actions)

Three automations, one workflow (`.github/workflows/gmail-automations.yml`),
running hourly on a normal GitHub-hosted runner with full internet access
(this replaces two Claude Code cloud routines that couldn't reach
`supabase.co` from their sandbox):

- `mark-sample-approved.mjs` / `mark-order-booked.mjs` — read
  `denovogb@gmail.com`, use Claude (Haiku) to judge/extract data from
  labeled threads, call a Supabase edge function.
- `generate-docket.mjs` — reads **`denovosourcing@gmail.com`** for incoming
  PO emails (CSV of order rows + PDF PO confirmation), and automates the
  "Generate Dockets & Import Orders" button in `web/index.html`: no LLM step,
  writes to Supabase directly with a service-role key. Its `Docket-Processed`
  / `Docket-Needs-Review` labels are created automatically by the script on
  first run — unlike `Sample-Approval` / `Bookings`, there's no manual
  labeling step to set up.

## One-time setup

### 1. Create a Google Cloud OAuth client

1. Go to https://console.cloud.google.com/ and create a project (or reuse one).
2. Enable the **Gmail API** and **Google Tasks API** (APIs & Services > Library).
3. Configure the **OAuth consent screen** (APIs & Services > OAuth consent
   screen): External, Testing mode. Add `denovogb@gmail.com` **and**
   `denovosourcing@gmail.com` as test users — the client is shared across
   both mailboxes (it identifies the app, not the mailbox; the mailbox
   binding only happens when you sign in during step 2).
4. Create credentials (APIs & Services > Credentials > Create Credentials >
   OAuth client ID) of type **Desktop app**. Note the Client ID and Client
   Secret — you'll need them in the next step and to add as GitHub secrets.

### 2. Get a refresh token per mailbox (run this yourself, not through Claude)

A refresh token is a long-lived credential with Gmail + Tasks access for
whichever account you sign in as — run this locally so it never appears in
a chat transcript. You need **one refresh token per mailbox** (two runs of
the same script, signing in as a different account each time). If you
already have a `denovogb` refresh token from before the switch to Google
Tasks, it won't have the `tasks` scope — re-run for that account too:

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

The sample-approval/booking secrets are existing shared secrets already
configured on the Supabase edge functions (previously only known to the
now-paused Claude Code routines) — reuse the same values so no edge function
redeploy is needed.

### 4. Test it

Actions tab > "Gmail automations" workflow > Run workflow (uses
`workflow_dispatch`, no need to wait for the hourly cron). Check the run logs
for the summary line each script prints at the end.

## Ongoing

Runs hourly via cron (`0 * * * *`, UTC) automatically once the secrets above
are in place. No further action needed.

If Google ever revokes a refresh token (rare — happens after ~6 months of
inactivity in Testing-mode consent screens, or if you change the account
password), re-run step 2 for that mailbox and update the matching secret
(`GMAIL_OAUTH_REFRESH_TOKEN` for `denovogb`, `GMAIL_SOURCING_OAUTH_REFRESH_TOKEN`
for `denovosourcing`).
