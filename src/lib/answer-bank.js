// Screening-question cache. Cache / similarity first; LLM only on a miss.
// Sensitive topics never auto-fill from a model guess.

import { get, set, getSettings } from "./storage.js";
import { askJSON } from "./llm/index.js";
import {
  normalizeQuestion,
  findSimilarAnswer,
  isSensitiveQuestion,
  classifyQuestion,
  answerFromProfile,
} from "./questions.js";

const BANK_KEY = "answerBank";

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
  const hit = findSimilarAnswer(bank, question);
  return hit ? { ...hit.entry, similarity: hit.similarity } : null;
}

export async function remember(question, answer, { source = "user", confidence = 1 } = {}) {
  const bank = await get(BANK_KEY, {});
  bank[normalizeQuestion(question)] = {
    answer,
    source,
    confidence,
    question,
    updatedAt: Date.now(),
  };
  await set(BANK_KEY, bank);
}

function bands(settings) {
  const c = settings?.confidence || {};
  return { auto: c.auto ?? 0.85, confirm: c.confirm ?? 0.6 };
}

function decideAction({ source, confidence, question, settings }) {
  const { auto, confirm } = bands(settings);
  const sensitive = isSensitiveQuestion(question);
  if (source === "user" || source === "excluded" || source === "profile") {
    if (sensitive && source !== "user") return "CONFIRM";
    return "FILL";
  }
  if (sensitive) return "CONFIRM";
  if (confidence >= auto) return "FILL";
  if (confidence >= confirm) return "CONFIRM";
  return "ASK";
}

/**
 * @returns {Promise<{
 *   action: "FILL"|"CONFIRM"|"ASK",
 *   answer?: string,
 *   source?: string,
 *   confidence?: number
 * }>}
 */
export async function resolve(question, options, profile) {
  const settings = await getSettings();

  const hit = await lookup(question);
  if (hit) {
    const action = decideAction({
      source: hit.source,
      confidence: hit.confidence ?? 1,
      question,
      settings,
    });
    return { action, answer: hit.answer, source: hit.source, confidence: hit.confidence ?? 1 };
  }

  const cls = classifyQuestion(question);
  const fromProfile = answerFromProfile(cls, profile || {});
  if (fromProfile != null) {
    const source = cls.kind === "experience_in" && fromProfile === "0"
      && (profile.excludedSkills || []).some((s) => question.toLowerCase().includes(String(s).toLowerCase()))
      ? "excluded"
      : "profile";
    const action = decideAction({ source, confidence: 1, question, settings });
    if (action === "FILL") {
      await remember(question, fromProfile, { source, confidence: 1 });
    }
    return { action, answer: fromProfile, source, confidence: 1 };
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

  const action = decideAction({
    source: "llm",
    confidence: result.confidence,
    question,
    settings,
  });
  if (action === "ASK") {
    return { action: "ASK", answer: undefined, source: "llm", confidence: result.confidence };
  }
  if (action === "FILL") {
    await remember(question, result.answer, { source: "llm", confidence: result.confidence });
  }
  return { action, answer: result.answer, source: "llm", confidence: result.confidence };
}

export async function exportBank() {
  return get(BANK_KEY, {});
}
