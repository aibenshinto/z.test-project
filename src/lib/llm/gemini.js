// Google Gemini adapter. Same askJSON contract.
// Note: Gemini's responseSchema is an OpenAPI subset and rejects
// `additionalProperties`, so we strip it on the way out.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const defaults = {
  // "latest" tracks the newest flash release. Pin an explicit version
  // (e.g. "gemini-3.8-flash") if you need reproducible behaviour.
  model: "gemini-flash-latest",
  maxTokens: 4096,
};

// Gemini returns 503 UNAVAILABLE under load - frequently, and on plain text
// requests, not just large ones. An unattended run must ride these out rather
// than surfacing them as a failure and tripping the governor's breaker.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

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
    // Exponential backoff with jitter: 1s, 2s, 4s (+/- 250ms).
    const wait = 2 ** (attempt - 1) * 1000 + Math.random() * 500 - 250;
    console.warn(`[gemini] ${res.status} - retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait)}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }

  if (!res.ok) {
    const { LLMError } = await import("./claude.js");
    const err = new LLMError(`gemini ${res.status}`, res.status, await res.text());
    err.retryable = RETRY_STATUS.has(res.status);
    throw err;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return { parsed: JSON.parse(text), usage: data.usageMetadata };
}
