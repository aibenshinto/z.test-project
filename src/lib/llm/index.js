// Provider router. Application code calls askJSON() and never names a vendor.
// Swap providers in settings; every caller is unaffected.

import * as claude from "./claude.js";
import * as openai from "./openai.js";
import * as gemini from "./gemini.js";
import { getSettings } from "../storage.js";
import { warn } from "../logger.js";

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
 * @param {Function} [opts.onRetry]  told of every wait before a retry, as well
 *                                   as the event log, so a busy provider
 *                                   shows on screen rather than as a hang
 * @returns {Promise<object>}    the parsed, schema-valid object
 */
export async function askJSON({ system, user, schema, task = "default", file, onRetry }) {
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
    onRetry(r) {
      warn(`The model is busy (${route.provider} ${r.status}); trying again in ${Math.round(r.waitMs / 1000)} s`,
        { task, attempt: r.attempt, of: r.of }).catch(() => {});
      onRetry?.(r);
    },
  });

  console.debug("[llm]", task, route.provider, route.model, usage);
  return parsed;
}
