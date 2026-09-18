// Google Gemini adapter. Same askJSON contract.
// Note: Gemini's responseSchema is an OpenAPI subset and rejects
// `additionalProperties`, so we strip it on the way out.

import { postJSON } from "./http.js";

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

/**
 * The wait Gemini itself asks for in a 429 (RetryInfo, e.g. "43s"), in ms,
 * or null when it names none.
 */
export function serverRetryDelay(body) {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(String(body || ""));
  return m ? Math.min(Math.round(Number(m[1]) * 1000), 120000) : null;
}

/**
 * Is this 429 the day's quota rather than the minute's? A daily quota only
 * resets the next day, so waiting and trying again only delays the failure
 * by minutes, with nothing on screen.
 */
export function isDailyQuota(body) {
  return /PerDay/.test(String(body || ""));
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

/**
 * @param {object}   opts
 * @param {Function} [opts.onRetry]  Told of every wait before a retry:
 *                                   { provider, status, attempt, of, waitMs }
 */
export async function askJSON({ apiKey, model, system, user, schema, maxTokens, file, onRetry }) {
  const m = model || defaults.model;

  // Key travels in a header, not the query string: query params leak into
  // logs, proxies and history.
  const send = () => postJSON(`${BASE}/${m}:generateContent`, {
    "content-type": "application/json", "x-goog-api-key": apiKey,
  }, {
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
  });

  let res;
  for (let attempt = 1; ; attempt++) {
    res = await send();
    if (res.ok) break;

    const body = await res.text();
    const daily = res.status === 429 && isDailyQuota(body);
    if (!RETRY_STATUS.has(res.status) || daily || attempt === MAX_ATTEMPTS) {
      const err = new LLMError(
        daily ? `gemini 429: the free daily quota for ${m} is used up` : `gemini ${res.status}`,
        res.status, body);
      err.retryable = RETRY_STATUS.has(res.status) && !daily;
      throw err;
    }

    const asked = res.status === 429 ? serverRetryDelay(body) : null;
    const wait = asked ?? retryDelay(attempt, res.status);
    console.warn(`[gemini] ${res.status} - retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(wait / 1000)}s`);
    try { onRetry?.({ provider: "gemini", status: res.status, attempt, of: MAX_ATTEMPTS - 1, waitMs: wait }); } catch (_) { /* cosmetic */ }
    await new Promise((r) => setTimeout(r, wait));
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text ?? "";
  try {
    return { parsed: JSON.parse(text), usage: data.usageMetadata };
  } catch (_) {
    // Cut off (MAX_TOKENS: a thinking model can spend the whole budget
    // thinking), blocked, or empty. Say which, not "Unexpected end of JSON".
    const why = candidate?.finishReason || data.promptFeedback?.blockReason || "empty reply";
    throw new LLMError(`gemini gave no usable answer (${why})`, res.status, text.slice(0, 500));
  }
}
