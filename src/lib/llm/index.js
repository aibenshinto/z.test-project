// Provider router. Application code calls askJSON() and never names a vendor.
// Swap providers in settings; every caller is unaffected.

import * as claude from "./claude.js";
import * as openai from "./openai.js";
import * as gemini from "./gemini.js";
import { getSettings } from "../storage.js";

const PROVIDERS = { claude, openai, gemini };

export function listProviders() {
  return Object.keys(PROVIDERS).map((id) => ({ id, defaults: PROVIDERS[id].defaults }));
}

/**
 * @param {object}  opts
 * @param {string}  opts.system  system prompt
 * @param {string}  opts.user    user prompt
 * @param {object}  opts.schema  JSON Schema the reply must satisfy
 * @param {string} [opts.task]   logical task name, for per-task provider overrides
 * @returns {Promise<object>}    the parsed, schema-valid object
 */
export async function askJSON({ system, user, schema, task = "default", file }) {
  const settings = await getSettings();
  const route = settings.llm.routes[task] || settings.llm.routes.default;
  const provider = PROVIDERS[route.provider];

  if (!provider) throw new Error(`unknown provider: ${route.provider}`);

  const apiKey = settings.llm.keys[route.provider];
  if (!apiKey) throw new Error(`no API key configured for ${route.provider}`);

  const { parsed, usage } = await provider.askJSON({
    apiKey,
    model: route.model,
    system,
    user,
    schema,
    maxTokens: route.maxTokens,
    file,
  });

  console.debug("[llm]", task, route.provider, route.model, usage);
  return parsed;
}
