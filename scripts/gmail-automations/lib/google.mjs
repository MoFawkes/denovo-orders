// Minimal Gmail + Calendar REST client for the GitHub Actions automations.
// No googleapis dependency — plain fetch against the REST APIs, since the
// surface area needed here (search, get, modify labels, create event) is
// small and a dependency-free script is simpler to audit and run in CI.

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRY_RUN = process.env.DRY_RUN === '1';

function logDryRun(action, details) {
  console.log(`[dry-run] ${action}: ${JSON.stringify(details)}`);
}

export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth token refresh failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token;
}

async function apiFetch(url, accessToken, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${options.method ?? 'GET'} ${url} -> ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// Gmail's search `q` param only matches labels by name (e.g. "Sample-Approval"),
// not by numeric label ID — confirmed by hand against this account's data.
export async function searchThreads(accessToken, query) {
  const threads = [];
  let pageToken;
  do {
    const url = new URL(`${GMAIL_BASE}/threads`);
    url.searchParams.set('q', query);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await apiFetch(url, accessToken);
    threads.push(...(json.threads ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return threads;
}

export async function getThread(accessToken, threadId) {
  return apiFetch(`${GMAIL_BASE}/threads/${threadId}?format=full`, accessToken);
}

export async function modifyThreadLabels(accessToken, threadId, { add = [], remove = [] }) {
  if (DRY_RUN) {
    logDryRun('modify Gmail thread labels', { threadId, add, remove });
    return null;
  }
  return apiFetch(`${GMAIL_BASE}/threads/${threadId}/modify`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
  });
}

function decodeBase64Url(data) {
  return Buffer.from(data, 'base64').toString('utf-8');
}

// Walks a message's MIME tree and returns every part that carries a
// filename (i.e. an attachment), regardless of nesting depth.
export function listAttachments(message) {
  const attachments = [];
  (function walk(node) {
    if (!node) return;
    if (node.filename && node.body?.attachmentId) {
      attachments.push({
        filename: node.filename,
        mimeType: node.mimeType,
        attachmentId: node.body.attachmentId,
        size: node.body.size ?? 0,
      });
    }
    (node.parts ?? []).forEach(walk);
  })(message.payload);
  return attachments;
}

// Attachment bytes are binary (PDF, xlsx, ...) so this returns a Buffer,
// unlike extractPlainTextBody's decodeBase64Url which assumes UTF-8 text.
export async function getAttachment(accessToken, messageId, attachmentId) {
  const json = await apiFetch(
    `${GMAIL_BASE}/messages/${messageId}/attachments/${attachmentId}`,
    accessToken,
  );
  return Buffer.from(json.data, 'base64');
}

export async function listLabels(accessToken) {
  const json = await apiFetch(`${GMAIL_BASE}/labels`, accessToken);
  return json.labels ?? [];
}

// Docket-generation labels are pure bookkeeping the script applies to its
// own output (unlike Sample-Approval/Bookings, which a human hand-applies
// to correspondence) -- create them on first run instead of requiring a
// manual setup step and hardcoded label IDs.
export async function getOrCreateLabel(accessToken, name) {
  const labels = await listLabels(accessToken);
  const existing = labels.find((l) => l.name === name);
  if (existing) return existing.id;

  if (DRY_RUN) {
    logDryRun('create Gmail label', { name });
    return `dry-run:${name}`;
  }

  const created = await apiFetch(`${GMAIL_BASE}/labels`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }),
  });
  return created.id;
}

// Walks a message's MIME tree and returns the best plaintext representation
// of the body: prefers text/plain, falls back to text/html with tags
// stripped (some senders — e.g. the PLT booking system — only send HTML).
export function extractPlainTextBody(message) {
  const parts = [];
  (function walk(node) {
    if (!node) return;
    if (node.parts) {
      node.parts.forEach(walk);
    } else if (node.mimeType && node.body?.data) {
      parts.push({ mimeType: node.mimeType, text: decodeBase64Url(node.body.data) });
    }
  })(message.payload);

  const plain = parts.find((p) => p.mimeType === 'text/plain');
  if (plain) return plain.text;

  const html = parts.find((p) => p.mimeType === 'text/html');
  if (html) {
    return html.text
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return message.snippet ?? '';
}

export function getHeader(message, name) {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// Sends a plain-text reply into an existing thread, threading it properly
// (In-Reply-To/References) so Gmail shows it inside the conversation. The
// gmail.modify scope already covers messages.send — no extra scope needed.
export function buildReplyMime({ to, subject, messageId, references, body, attachments = [] }) {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject.startsWith('Re:') ? subject : `Re: ${subject}`}`,
    messageId ? `In-Reply-To: ${messageId}` : null,
    references ? `References: ${references}` : null,
  ].filter(Boolean);
  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'MIME-Version: 1.0');
    return `${headers.join('\r\n')}\r\n\r\n${body}`;
  }
  const boundary = `denovo-${Date.now()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, 'MIME-Version: 1.0');
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`,
    ...attachments.map(({ filename, mimeType, buffer }) => {
      const encoded = buffer.toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
      return `--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}`;
    }),
  ];
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n--${boundary}--`;
}

export async function sendReply(accessToken, { threadId, replyTo, to, subject, body, attachments = [] }) {
  if (DRY_RUN) {
    logDryRun('send Gmail reply', { threadId, to, subject, bodyPreview: body.slice(0, 160), attachments: attachments.map((a) => a.filename) });
    return { id: 'dry-run-message', threadId };
  }
  const messageId = getHeader(replyTo, 'Message-ID');
  const references = [getHeader(replyTo, 'References'), messageId].filter(Boolean).join(' ');
  const raw = Buffer.from(
    buildReplyMime({ to, subject, messageId, references, body, attachments }),
    'utf-8',
  ).toString('base64url');
  return apiFetch(`${GMAIL_BASE}/messages/send`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ raw, threadId }),
  });
}

// Creates a Google Task on the default "My Tasks" list, so it shows up as a
// checkable to-do (with a due date) rather than a fixed-time calendar event.
export async function createTask(accessToken, { title, notes, dueDate }) {
  if (DRY_RUN) {
    logDryRun('create Google Task', { title, notes, dueDate });
    return { id: 'dry-run-task', title, notes };
  }
  return apiFetch(`${TASKS_BASE}/lists/@default/tasks`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      title,
      notes,
      due: `${dueDate}T00:00:00.000Z`,
    }),
  });
}

// Lists open (not yet completed) tasks on the default list.
export async function listOpenTasks(accessToken) {
  const tasks = [];
  let pageToken;
  do {
    const url = new URL(`${TASKS_BASE}/lists/@default/tasks`);
    url.searchParams.set('showCompleted', 'false');
    url.searchParams.set('maxResults', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await apiFetch(url, accessToken);
    tasks.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return tasks;
}

export async function patchTask(accessToken, taskId, fields) {
  if (DRY_RUN) {
    logDryRun('update Google Task', { taskId, fields });
    return { id: taskId, ...fields };
  }
  return apiFetch(`${TASKS_BASE}/lists/@default/tasks/${taskId}`, accessToken, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

// Requires the drive.readonly scope on the refresh token (see oauth-setup.mjs).
export async function driveListFiles(accessToken, query) {
  const files = [];
  let pageToken;
  do {
    const url = new URL(`${DRIVE_BASE}/files`);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', 'nextPageToken, files(id, name, modifiedTime)');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await apiFetch(url, accessToken);
    files.push(...(json.files ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return files;
}

// Downloads a Drive file's raw bytes (e.g. an .xlsx packing list).
export async function driveDownloadFile(accessToken, fileId) {
  const res = await fetch(`${DRIVE_BASE}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`GET drive file ${fileId} -> ${res.status} ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Uploads a new file into My Drive (root). Requires the drive.file scope on
// the refresh token — narrower than full drive access: it only grants the
// app its own uploads, not the rest of the Drive (see oauth-setup.mjs).
export async function driveUploadFile(accessToken, { name, mimeType, buffer, appProperties }) {
  if (DRY_RUN) {
    logDryRun('upload Drive file', { name, mimeType, bytes: buffer.length, appProperties });
    return { id: 'dry-run-drive-file', name };
  }
  const boundary = `denovo-${Date.now()}`;
  const metadata = JSON.stringify({ name, mimeType, ...(appProperties ? { appProperties } : {}) });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf-8',
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--`, 'utf-8'),
  ]);
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`POST drive upload -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Message-level tracking lets a later CSV in the same conversation run independently.
export async function searchMessages(accessToken, query) {
  const messages = [];
  let pageToken;
  do {
    const url = new URL(`${GMAIL_BASE}/messages`);
    url.searchParams.set('q', query);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await apiFetch(url, accessToken);
    messages.push(...(json.messages ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return messages;
}

export async function getMessage(accessToken, messageId) {
  return apiFetch(`${GMAIL_BASE}/messages/${messageId}?format=full`, accessToken);
}

export async function modifyMessageLabels(accessToken, messageId, { add = [], remove = [] }) {
  if (DRY_RUN) {
    logDryRun('modify Gmail message labels', { messageId, add, remove });
    return null;
  }
  return apiFetch(`${GMAIL_BASE}/messages/${messageId}/modify`, accessToken, {
    method: 'POST', body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
  });
}

// ── PLT invoicing (send-plt-invoices.mjs) ───────────────────────────────────

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// Completed tasks on the default list, including ones Tasks has hidden
// after completion. completedMin bounds the scan to recent bookings.
export async function listCompletedTasks(accessToken, { completedMin } = {}) {
  const tasks = [];
  let pageToken;
  do {
    const url = new URL(`${TASKS_BASE}/lists/@default/tasks`);
    url.searchParams.set('showCompleted', 'true');
    url.searchParams.set('showHidden', 'true');
    url.searchParams.set('maxResults', '100');
    if (completedMin) url.searchParams.set('completedMin', completedMin);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await apiFetch(url, accessToken);
    tasks.push(...(json.items ?? []).filter((task) => task.status === 'completed'));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return tasks;
}

// Requires the spreadsheets scope on the refresh token (see oauth-setup.mjs).
export async function sheetsGetSheetId(accessToken, spreadsheetId, title) {
  const url = new URL(`${SHEETS_BASE}/${spreadsheetId}`);
  url.searchParams.set('fields', 'sheets.properties(sheetId,title)');
  const json = await apiFetch(url, accessToken);
  const sheet = (json.sheets ?? []).find((s) => s.properties.title === title);
  if (!sheet) throw new Error(`sheet "${title}" not found in spreadsheet ${spreadsheetId}`);
  return sheet.properties.sheetId;
}

// Evaluated amounts/dates, so formula-based due dates can also be aged.
export async function sheetsGetValues(accessToken, spreadsheetId, range) {
  const url = new URL(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
  url.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');
  const json = await apiFetch(url, accessToken);
  return json.values ?? [];
}

export async function sheetsInsertRows(accessToken, spreadsheetId, sheetId, startIndex, count) {
  if (DRY_RUN) {
    logDryRun('insert statement rows', { spreadsheetId, sheetId, startIndex, count });
    return null;
  }
  return apiFetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        insertDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex, endIndex: startIndex + count },
          inheritFromBefore: true,
        },
      }],
    }),
  });
}

export async function sheetsUpdateValues(accessToken, spreadsheetId, data, valueInputOption) {
  if (data.length === 0) return null;
  if (DRY_RUN) {
    logDryRun('update statement cells', { spreadsheetId, valueInputOption, data });
    return null;
  }
  return apiFetch(`${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption, data }),
  });
}

// Exports a Google-native file (e.g. the statement sheet) to another format.
export async function driveExportFile(accessToken, fileId, mimeType) {
  const url = new URL(`${DRIVE_BASE}/files/${fileId}/export`);
  url.searchParams.set('mimeType', mimeType);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`GET drive export ${fileId} -> ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

export function buildMessageMime({ to, subject, body, attachments = [], messageId }) {
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`;
  const boundary = `denovo-${Date.now()}`;
  const headers = [
    `To: ${to.join(', ')}`,
    `Subject: ${encodedSubject}`,
    ...(messageId ? [`Message-ID: <${messageId}>`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`,
    ...attachments.map(({ filename, mimeType, buffer }) => {
      const encoded = buffer.toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
      return `--${boundary}\r\nContent-Type: ${mimeType}; name="${filename}"\r\nContent-Disposition: attachment; filename="${filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}`;
    }),
  ];
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n--${boundary}--`;
}

// Saves (does not send) a new message in the mailbox's Drafts.
export async function createDraft(accessToken, { to, subject, body, attachments = [], messageId }) {
  if (DRY_RUN) {
    logDryRun('create Gmail draft', { to, subject, attachments: attachments.map((a) => a.filename) });
    return { id: 'dry-run-draft' };
  }
  const raw = Buffer.from(buildMessageMime({ to, subject, body, attachments, messageId }), 'utf-8').toString('base64url');
  return apiFetch(`${GMAIL_BASE}/drafts`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ message: { raw } }),
  });
}

export async function sendInvoiceMessage(accessToken, { to, subject, body, attachments = [], messageId }) {
  if (DRY_RUN) {
    logDryRun('send invoice email', { to, subject, attachments: attachments.map((a) => a.filename) });
    return { id: 'dry-run-message' };
  }
  const raw = Buffer.from(buildMessageMime({ to, subject, body, attachments, messageId }), 'utf-8').toString('base64url');
  return apiFetch(`${GMAIL_BASE}/messages/send`, accessToken, {
    method: 'POST', body: JSON.stringify({ raw }),
  });
}

// Insert/move rows and set values in one atomic Sheets request. A retry reads
// the live sheet before planning again, so it never repeats a row insertion.
export async function sheetsApplyPlan(accessToken, spreadsheetId, sheetId, plan) {
  const cellValue = (value, raw) => {
    if (typeof value === 'number') return { numberValue: value };
    if (typeof value === 'boolean') return { boolValue: value };
    if (!raw && String(value).startsWith('=')) return { formulaValue: value };
    return { stringValue: String(value ?? '') };
  };
  const columnIndex = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const requests = [...(plan.requests ?? [])];
  if (plan.count) requests.push({ insertDimension: {
    range: { sheetId, dimension: 'ROWS', startIndex: plan.insertAt, endIndex: plan.insertAt + plan.count },
    inheritFromBefore: true,
  } });
  if (plan.count && Number.isInteger(plan.formatSourceIndex)) {
    const source = plan.formatSourceIndex >= plan.insertAt ? plan.formatSourceIndex + plan.count : plan.formatSourceIndex;
    for (let offset = 0; offset < plan.count; offset++) {
      const row = plan.insertAt + offset;
      const range = { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 6 };
      requests.push({ copyPaste: { source: { ...range, startRowIndex: source, endRowIndex: source + 1 }, destination: range, pasteType: 'PASTE_FORMAT' } });
      const shade = (plan.stripeStart + offset) % 2 ? 0.9490196 : 1;
      requests.push({ repeatCell: { range: { ...range, endColumnIndex: 5 }, cell: { userEnteredFormat: { backgroundColor: { red: shade, green: shade, blue: shade } } }, fields: 'userEnteredFormat.backgroundColor' } });
      for (const col of [1, 4]) requests.push({ repeatCell: { range: { ...range, startColumnIndex: col, endColumnIndex: col + 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/MM/yyyy' } } }, fields: 'userEnteredFormat.numberFormat' } });
    }
  }
  for (const update of plan.updates) {
    const match = update.range.match(/^([A-Z]+)(\d+)/);
    if (!match) throw new Error(`Invalid statement update range: ${update.range}`);
    requests.push({ updateCells: {
      start: { sheetId, rowIndex: Number(match[2]) - 1, columnIndex: columnIndex(match[1]) },
      rows: update.values.map((row) => ({ values: row.map((value) => ({ userEnteredValue: cellValue(value, update.raw) })) })),
      fields: 'userEnteredValue',
    } });
  }
  // Size wrapped charge rows after their new values have been written.
  const resizeRequests = requests.filter(request => request.autoResizeDimensions);
  for (let index = requests.length - 1; index >= 0; index--) {
    if (requests[index].autoResizeDimensions) requests.splice(index, 1);
  }
  requests.push(...resizeRequests);
  if (DRY_RUN) { logDryRun('atomic statement update', { spreadsheetId, requests }); return null; }
  return apiFetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, accessToken, {
    method: 'POST', body: JSON.stringify({ requests }),
  });
}

export async function sheetsGetNotes(accessToken, spreadsheetId, sheet) {
  const url = new URL(`${SHEETS_BASE}/${spreadsheetId}`);
  url.searchParams.set('ranges', `'${sheet.replaceAll("'", "''")}'!A1:I`);
  url.searchParams.set('includeGridData', 'true');
  url.searchParams.set('fields', 'sheets(data(startRow,startColumn,rowData(values(note))))');
  const data = await apiFetch(url, accessToken);
  const notes = new Map();
  for (const block of data.sheets?.[0]?.data ?? []) {
    (block.rowData ?? []).forEach((row, r) => row.values?.forEach((cell, c) => {
      if (cell.note) notes.set(`${(block.startRow ?? 0) + r}:${(block.startColumn ?? 0) + c}`, cell.note);
    }));
  }
  return notes;
}
