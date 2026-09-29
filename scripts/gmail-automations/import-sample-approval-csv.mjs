import { getAccessToken, searchMessages, getMessage, getAttachment, getOrCreateLabel, modifyMessageLabels } from './lib/google.mjs';
import { processChaseMessage } from './lib/sample-approval-csv.mjs';

const QUERY = 'from:lulu.marshall@prettylittlething.com subject:"Dresses OPO Chase" has:attachment filename:csv after:2026/09/24 -in:trash -in:spam -label:Sample-CSV-Processed -label:Sample-CSV-Needs-Review';
const FUNCTIONS_URL = process.env.SUPABASE_FUNCTIONS_URL ?? 'https://sfwnmddlmiprvsoxbatz.supabase.co/functions/v1';

async function main() {
  const token = await getAccessToken({ clientId: process.env.GMAIL_OAUTH_CLIENT_ID, clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET, refreshToken: process.env.GMAIL_OAUTH_REFRESH_TOKEN });
  const processed = await getOrCreateLabel(token, 'Sample-CSV-Processed');
  const review = await getOrCreateLabel(token, 'Sample-CSV-Needs-Review');
  let failed = 0;
  const messages = await searchMessages(token, QUERY);
  for (const item of messages) {
    try {
      await processChaseMessage(await getMessage(token, item.id), {
        dryRun: process.env.DRY_RUN === '1',
        readAttachment: async id => {
          if (!id) throw new Error('Missing CSV attachment bytes');
          try { return (await getAttachment(token, item.id, id)).toString('utf8'); }
          catch (error) { error.retryable = true; throw error; }
        },
        approve: async pairs => {
          const response = await fetch(FUNCTIONS_URL + '/mark-sample-approved', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-automation-secret': process.env.SAMPLE_APPROVAL_SECRET },
            body: JSON.stringify({ mode: 'csv', pairs }),
          });
          if (!response.ok) throw new Error('Approval endpoint HTTP ' + response.status + ': ' + await response.text());
          return response.json();
        },
        label: state => modifyMessageLabels(token, item.id, { add: [state === 'review' ? review : processed] }),
      });
    } catch (error) { failed++; console.error('Retry next run:', item.id, error.message); }
  }
  console.log('CSV messages checked: ' + messages.length + '; failed: ' + failed);
  if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
