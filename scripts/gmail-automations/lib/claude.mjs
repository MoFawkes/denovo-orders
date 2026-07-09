// Thin wrapper around the Anthropic Messages API for the judgment/extraction
// step (deciding whether an email is genuine, pulling out PO/style/date
// fields). Asks for strict JSON and throws if the model doesn't comply —
// callers treat a throw the same as "needs review", never as a silent skip.

const API_URL = 'https://api.anthropic.com/v1/messages';
// Haiku is enough for the text automations: classify genuine/not + pull a
// handful of structured fields out of a fairly formulaic email. Anything the
// model is unsure about gets flagged Needs Review by the caller rather than
// guessed, so a cheaper/less capable model mainly shifts a few more
// borderline cases into that bucket rather than causing silent wrong answers.
// Callers that read handwriting off photos (draft-packing-list.mjs) override
// `model` with Sonnet — a misread digit there becomes a wrong carton count,
// not just a Needs Review flag, so the stronger vision model earns its cost.
const MODEL = 'claude-haiku-4-5-20251001';

// `images`: optional array of { mediaType, data } (base64, no data: prefix)
// sent as vision inputs ahead of the prompt text.
export async function extractJson({ apiKey, system, prompt, maxTokens = 1024, model = MODEL, images = [] }) {
  const content = [
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })),
    { type: 'text', text: prompt },
  ];
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
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
