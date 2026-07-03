# Gmail automations (GitHub Actions)

Replaces the two Claude Code cloud routines ("Sample Approval Gmail Parser",
"Order booking processor") that could not reach `supabase.co` from their
sandbox. These run as a normal GitHub Actions workflow instead, on a
schedule, with full internet access — see `.github/workflows/gmail-automations.yml`.

## One-time setup

### 1. Create a Google Cloud OAuth client

1. Go to https://console.cloud.google.com/ and create a project (or reuse one).
2. Enable the **Gmail API** and **Google Calendar API** (APIs & Services > Library).
3. Configure the **OAuth consent screen** (APIs & Services > OAuth consent
   screen): External, Testing mode. Add `denovogb@gmail.com` as a test user.
4. Create credentials (APIs & Services > Credentials > Create Credentials >
   OAuth client ID) of type **Desktop app**. Note the Client ID and Client
   Secret — you'll need them in the next step and to add as GitHub secrets.

### 2. Get a refresh token (run this yourself, not through Claude)

The refresh token is a long-lived credential with Gmail + Calendar access —
run this locally so it never appears in a chat transcript:

```powershell
$env:GMAIL_OAUTH_CLIENT_ID = "<client id from step 1>"
$env:GMAIL_OAUTH_CLIENT_SECRET = "<client secret from step 1>"
node scripts/gmail-automations/oauth-setup.mjs
```

Open the printed URL, sign in as `denovogb@gmail.com`, grant access. The
script prints a refresh token — copy it immediately, it's only shown once
(you can always re-run the script to get a new one if needed).

### 3. Add GitHub repository secrets

Settings > Secrets and variables > Actions > New repository secret, for each of:

| Secret name | Value |
|---|---|
| `GMAIL_OAUTH_CLIENT_ID` | from step 1 |
| `GMAIL_OAUTH_CLIENT_SECRET` | from step 1 |
| `GMAIL_OAUTH_REFRESH_TOKEN` | from step 2 |
| `ANTHROPIC_API_KEY` | an Anthropic API key (console.anthropic.com) |
| `SAMPLE_APPROVAL_SECRET` | must match the `SAMPLE_APPROVAL_SECRET` env var already set on the `mark-sample-approved` Supabase edge function |
| `BOOKING_AUTOMATION_SECRET` | must match the `BOOKING_AUTOMATION_SECRET` env var already set on the `mark-order-booked` Supabase edge function |

The last two are existing shared secrets already configured on the Supabase
edge functions (previously only known to the now-paused Claude Code
routines) — reuse the same values so no edge function redeploy is needed.

### 4. Test it

Actions tab > "Gmail automations" workflow > Run workflow (uses
`workflow_dispatch`, no need to wait for the hourly cron). Check the run logs
for the summary line each script prints at the end.

## Ongoing

Runs hourly via cron (`0 * * * *`, UTC) automatically once the secrets above
are in place. No further action needed.

If Google ever revokes the refresh token (rare — happens after ~6 months of
inactivity in Testing-mode consent screens, or if you change the account
password), re-run step 2 and update the `GMAIL_OAUTH_REFRESH_TOKEN` secret.
