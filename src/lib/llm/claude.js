// Anthropic adapter. Raw HTTP: no SDK, no bundler.
// Called only from the service worker, where host_permissions removes CORS concerns.

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export const defaults = {
  model: "claude-opus-5",   // "claude-haiku-4-5" is ~5x cheaper for question answering
  maxTokens: 4096,
};

export async function askJSON({ apiKey, model, system, user, schema, maxTokens, file }) {
  // `file` carries an optional image (e.g. a viewport screenshot) as
  // { mime, b64 }. Text-only calls pass a plain string as before.
  const content = file?.b64
    ? [
        { type: "image", source: { type: "base64", media_type: file.mime || "image/png", data: file.b64 } },
        { type: "text", text: user },
      ]
    : user;

  const body = {
    model: model || defaults.model,
    max_tokens: maxTokens || defaults.maxTokens,
    system,
    messages: [{ role: "user", content }],
    output_config: {
      format: { type: "json_schema", schema },
    },
  };

  // Opus 5 may decline a request outright (HTTP 200, stop_reason "refusal").
  // Server-side fallbacks re-run it on a fallback model inside the same call.
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    "anthropic-beta": "server-side-fallback-2026-07-01",
  };
  body.fallbacks = "default";

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new LLMError(`anthropic ${res.status}`, res.status, detail);
  }

  const data = await res.json();

  if (data.stop_reason === "refusal") {
    throw new LLMError(
      `anthropic refused: ${data.stop_details?.category ?? "unknown"}`,
      200,
      data.stop_details?.explanation ?? ""
    );
  }

  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  return { parsed: JSON.parse(text), usage: data.usage };
}

export class LLMError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.detail = detail;
  }
}
