// OpenAI adapter. Same askJSON contract as claude.js.

// Static imports only: ServiceWorkerGlobalScope forbids import(), so the
// dynamic one this used to make on an error threw instead of reporting it.
import { postJSON } from "./http.js";
import { LLMError } from "./claude.js";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

export const defaults = {
  model: "gpt-4o",   // set whatever model your key has access to in settings
  maxTokens: 4096,
};

export async function askJSON({ apiKey, model, system, user, schema, maxTokens, file }) {
  // `file` carries an optional image (e.g. a viewport screenshot) as
  // { mime, b64 }. Text-only calls pass a plain string as before.
  const userContent = file?.b64
    ? [
        { type: "text", text: user },
        { type: "image_url", image_url: { url: `data:${file.mime || "image/png"};base64,${file.b64}` } },
      ]
    : user;

  const res = await postJSON(ENDPOINT, {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  }, {
    model: model || defaults.model,
    max_tokens: maxTokens || defaults.maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "response", strict: true, schema },
    },
  });

  if (!res.ok) {
    throw new LLMError(`openai ${res.status}`, res.status, await res.text());
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  return { parsed: JSON.parse(text), usage: data.usage };
}
