// Screening-question cache. ~90% of questions repeat across applications, so
// after the first week almost every lookup is a free, instant, consistent hit.
// Only genuine cache misses reach an LLM.

import { get, set } from "./storage.js";
import { askJSON } from "./llm/index.js";

const BANK_KEY = "answerBank";

const normalize = (q) =>
  q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The value to enter or the option to select" },
    confidence: { type: "number", description: "0 to 1" },
    reasoning: { type: "string" },
  },
  required: ["answer", "confidence", "reasoning"],
  additionalProperties: false,
};

export async function lookup(question) {
  const bank = await get(BANK_KEY, {});
  return bank[normalize(question)] ?? null;
}

export async function remember(question, answer, { source = "user" } = {}) {
  const bank = await get(BANK_KEY, {});
  bank[normalize(question)] = {
    answer,
    source,
    question,                 // keep the original for the settings UI
    updatedAt: Date.now(),
  };
  await set(BANK_KEY, bank);
}

/**
 * Resolve a screening question. Cache first; LLM only on a miss.
 * Returns { answer, source, confidence } or null if it needs a human.
 */
export async function resolve(question, options, profile) {
  const hit = await lookup(question);
  if (hit) return { ...hit, confidence: 1 };

  // Never let the model answer for a skill the user has disclaimed.
  const m = question.toLowerCase().match(/experience do you have in (.+?)\?/);
  if (m && (profile.excludedSkills || []).some((s) => s.toLowerCase() === m[1].trim())) {
    return { answer: "0", source: "excluded", confidence: 1 };
  }

  const result = await askJSON({
    task: "answerQuestion",
    system:
      "You fill in job application screening questions on behalf of a candidate. " +
      "Answer strictly from the candidate profile provided. Never invent experience, " +
      "credentials, or authorization the profile does not state. If the profile does " +
      "not support an answer, set confidence below 0.5.",
    user: [
      `Candidate profile:\n${JSON.stringify(profile, null, 2)}`,
      `Question: ${question}`,
      options?.length ? `Must be one of: ${JSON.stringify(options)}` : "Free-text answer.",
    ].join("\n\n"),
    schema: ANSWER_SCHEMA,
  });

  // Low confidence means the profile did not support an answer. Do not guess
  // on an application - queue it for the user instead.
  if (result.confidence < 0.5) return null;

  await remember(question, result.answer, { source: "llm" });
  return { answer: result.answer, source: "llm", confidence: result.confidence };
}

export async function exportBank() {
  return get(BANK_KEY, {});
}
