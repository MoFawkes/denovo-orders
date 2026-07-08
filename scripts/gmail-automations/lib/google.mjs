// Minimal Gmail + Calendar REST client for the GitHub Actions automations.
// No googleapis dependency — plain fetch against the REST APIs, since the
// surface area needed here (search, get, modify labels, create event) is
// small and a dependency-free script is simpler to audit and run in CI.

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

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

// Creates a Google Task on the default "My Tasks" list, so it shows up as a
// checkable to-do (with a due date) rather than a fixed-time calendar event.
export async function createTask(accessToken, { title, notes, dueDate }) {
  return apiFetch(`${TASKS_BASE}/lists/@default/tasks`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      title,
      notes,
      due: `${dueDate}T00:00:00.000Z`,
    }),
  });
}
