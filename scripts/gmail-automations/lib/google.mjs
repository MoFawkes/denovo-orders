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
export async function sendReply(accessToken, { threadId, replyTo, to, subject, body }) {
  if (DRY_RUN) {
    logDryRun('send Gmail reply', { threadId, to, subject, bodyPreview: body.slice(0, 160) });
    return { id: 'dry-run-message', threadId };
  }
  const messageId = getHeader(replyTo, 'Message-ID');
  const references = [getHeader(replyTo, 'References'), messageId].filter(Boolean).join(' ');
  const headers = [
    `To: ${to}`,
    `Subject: ${subject.startsWith('Re:') ? subject : `Re: ${subject}`}`,
    messageId ? `In-Reply-To: ${messageId}` : null,
    references ? `References: ${references}` : null,
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf-8').toString('base64url');
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
