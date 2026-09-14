// Google Gemini adapter. Same askJSON contract.
// Note: Gemini's responseSchema is an OpenAPI subset and rejects
// `additionalProperties`, so we strip it on the way out.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Defined inline so gemini.js never needs a dynamic import() at runtime.
// ServiceWorkerGlobalScope forbids import() by spec (HTML § 8.1.6.3).
class LLMError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.body = body;
  }
}

export { LLMError };

export const defaults = {
  // "latest" tracks the newest flash release. Pin an explicit version
  // (e.g. "gemini-3.8-flash") if you need reproducible behaviour.
  model: "gemini-flash-latest",
  maxTokens: 4096,
};

// Gemini returns 503 UNAVAILABLE under load - frequently, and on plain text
// requests, not just large ones. An unattended run must ride these out rather
// than surfacing them as a failure and tripping the governor's breaker.
// 429 = quota / rate limit — needs a much longer wait than a transient 5xx.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;

// Wait strategy:
//   429 (rate limit): 15 s → 30 s → 60 s → 120 s (+/- 2 s jitter)
//   5xx (transient) :  2 s →  4 s →  8 s →  16 s (+/- 0.5 s jitter)
function retryDelay(attempt, status) {
  const isRateLimit = status === 429;
  const base = isRateLimit ? 15000 : 2000;
  const jitter = isRateLimit ? (Math.random() * 4000 - 2000) : (Math.random() * 1000 - 500);
  return Math.round(base * 2 ** (attempt - 1) + jitter);
}

function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "additionalProperties") continue;
      out[k] = toGeminiSchema(v);
    }
    return out;
  }
  return node;
}

export async function askJSON({ apiKey, model, system, user, schema, maxTokens, file }) {
  const m = model || defaults.model;

  // Key travels in a header, not the query string: query params leak into
  // logs, proxies and history.
  const send = () => fetch(`${BASE}/${m}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{
        role: "user",
        parts: file
          ? [{ inlineData: { mimeType: file.mime, data: file.b64 } }, { text: user }]
          : [{ text: user }],
      }],
      generationConfig: {
        maxOutputTokens: maxTokens || defaults.maxTokens,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(schema),
      },
    }),
  });

  let res;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await send();
    if (res.ok) break;
    if (!RETRY_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) break;
    const wait = retryDelay(attempt, res.status);
    console.warn(`[gemini] ${res.status} - retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait / 1000)}s`);
    await new Promise((r) => setTimeout(r, wait));
  }

  if (!res.ok) {
    const err = new LLMError(`gemini ${res.status}`, res.status, await res.text());
    err.retryable = RETRY_STATUS.has(res.status);
    throw err;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return { parsed: JSON.parse(text), usage: data.usageMetadata };
}
