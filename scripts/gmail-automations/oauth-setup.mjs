// ONE-TIME LOCAL SETUP — run this yourself, not through Claude, so the
// refresh token it prints never leaves your machine via chat/logs.
//
// Usage (PowerShell):
//   $env:GMAIL_OAUTH_CLIENT_ID = "your-client-id"
//   $env:GMAIL_OAUTH_CLIENT_SECRET = "your-client-secret"
//   node scripts/gmail-automations/oauth-setup.mjs
//
// Requires a Google Cloud OAuth client of type "Desktop app" (supports the
// loopback redirect below without pre-registering an exact port). See
// scripts/gmail-automations/README.md for full setup steps.
import http from 'node:http';

const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/tasks',
  // Read-only Drive access: complete-order-from-packing-list.mjs scans the
  // denovogb Drive for "INV ..." packing lists. Tokens issued before this
  // scope was added won't have it — re-run this setup if Drive calls 403.
  'https://www.googleapis.com/auth/drive.readonly',
  // Write access limited to the app's own uploads: draft-packing-list.mjs
  // creates the generated "INV ..." sheets in Drive. Same re-run rule as
  // above if uploads 403.
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET first.');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent'); // force a refresh_token even on re-auth

console.log('Open this URL in your browser and sign in as the mailbox you are minting a token for');
console.log('(denovogb@gmail.com or denovosourcing@gmail.com — one run per mailbox):\n');
console.log(authUrl.toString());
console.log('\nWaiting for the redirect back to localhost...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorization denied. Check your terminal.');
    console.error(`Authorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Done — you can close this tab and return to your terminal.');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });

  const tokenJson = await tokenRes.json();
  server.close();

  if (!tokenJson.refresh_token) {
    console.error('No refresh_token in response — did you already grant consent before without `prompt=consent`?');
    console.error(JSON.stringify(tokenJson, null, 2));
    process.exit(1);
  }

  console.log('Success. Add this as a GitHub secret (Settings > Secrets and variables > Actions).');
  console.log('The secret name depends on which account you just signed in as:\n');
  console.log('  denovogb@gmail.com        -> GMAIL_OAUTH_REFRESH_TOKEN');
  console.log('  denovosourcing@gmail.com  -> GMAIL_SOURCING_OAUTH_REFRESH_TOKEN\n');
  console.log(tokenJson.refresh_token);
  console.log('\nThis value is only shown here, in your own terminal — copy it now.');
});

server.listen(PORT);
