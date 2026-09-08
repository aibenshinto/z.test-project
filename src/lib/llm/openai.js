// OpenAI adapter. Same askJSON contract as claude.js.

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

export const defaults = {
  model: "gpt-4o",   // set whatever model your key has access to in settings
  maxTokens: 4096,
};

export async function askJSON({ apiKey, model, system, user, schema, maxTokens }) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || defaults.model,
      max_tokens: maxTokens || defaults.maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "response", strict: true, schema },
      },
    }),
  });

  if (!res.ok) {
    const { LLMError } = await import("./claude.js");
    throw new LLMError(`openai ${res.status}`, res.status, await res.text());
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  return { parsed: JSON.parse(text), usage: data.usage };
}
