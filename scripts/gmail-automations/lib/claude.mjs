// Thin wrapper around the Anthropic Messages API for the judgment/extraction
// step (deciding whether an email is genuine, pulling out PO/style/date
// fields). Asks for strict JSON and throws if the model doesn't comply —
// callers treat a throw the same as "needs review", never as a silent skip.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';

export async function extractJson({ apiKey, system, prompt, maxTokens = 1024 }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  const text = json.content?.map((b) => b.text ?? '').join('') ?? '';

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Model did not return JSON. Raw output: ${text.slice(0, 500)}`);
  }
  return JSON.parse(match[0]);
}
