// AI Decision Engine — service-worker side.
//
// Pure module: no DOM, no chrome.* calls. Importable from the service worker.
//
// Two responsibilities:
//   1. buildCandidateContext(profile) — produce a concise, safe slice of the
//      candidate profile to send to the AI. Never includes API keys, full
//      resume text, or fields the profile does not contain.
//   2. decideAction(snapshot, profile, askJSON) — call the configured LLM with
//      the UISnapshot + candidate context and return a validated AgentAction.
//
// The AI is NEVER allowed to return arbitrary JavaScript, CSS selectors, or
// actions outside the allowed set. Any out-of-schema response is coerced to
// { action: "stop", reason: "invalid AI response" }.

// ---------------------------------------------------------------------------
// Allowed action vocabulary
// ---------------------------------------------------------------------------

const ALLOWED_ACTIONS = new Set([
  "click",
  "type",
  "select",
  "check",
  "uncheck",
  "upload",
  "wait",
  "ask_user",
  "finish",
  "stop",
]);

// ---------------------------------------------------------------------------
// JSON Schema the AI must satisfy
// ---------------------------------------------------------------------------

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...ALLOWED_ACTIONS],
      description: "The action to perform",
    },
    target: {
      type: "string",
      description: "Temporary element ID (element_N) from the snapshot. Required for all actions except wait, finish, stop, ask_user.",
    },
    value: {
      type: "string",
      description: "For type: the text to enter. For wait: milliseconds as a string.",
    },
    question: {
      type: "string",
      description: "For ask_user: the question to present to the human.",
    },
    reason: {
      type: "string",
      description: "Brief explanation of why this action was chosen.",
    },
    confidence: {
      type: "number",
      description: "0 to 1 confidence in this action.",
    },
  },
  required: ["action"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Candidate context builder
// ---------------------------------------------------------------------------

/**
 * Build a concise, safe candidate context from the full profile.
 *
 * Rules:
 * - Only include fields that are non-null and non-empty.
 * - Never include: API keys, resumeText, b64 blobs, _validation internals.
 * - The AI uses this to CHOOSE from existing values — it must NOT invent new ones.
 *
 * @param {object} profile
 * @returns {object} candidateContext
 */
export function buildCandidateContext(profile) {
  if (!profile) return {};
  const ctx = {};

  if (profile.fullName)          ctx.name              = profile.fullName;
  if (profile.currentTitle)      ctx.currentTitle      = profile.currentTitle;
  if (profile.totalYears != null) ctx.experienceYears  = profile.totalYears;
  if (profile.location)          ctx.currentLocation   = profile.location;

  if (Array.isArray(profile.preferredLocations) && profile.preferredLocations.length) {
    ctx.preferredLocations = profile.preferredLocations;
  }

  if (Array.isArray(profile.skills) && profile.skills.length) {
    ctx.skills = profile.skills.map((s) => ({ name: s.name, years: s.years }));
  }

  if (Array.isArray(profile.excludedSkills) && profile.excludedSkills.length) {
    ctx.excludedSkills = profile.excludedSkills;
  }

  if (profile.noticePeriodDays != null) ctx.noticePeriodDays     = profile.noticePeriodDays;
  if (profile.workAuthorization)        ctx.workAuthorization     = profile.workAuthorization;
  if (profile.visaSponsorship)          ctx.requiresVisa          = profile.visaSponsorship;
  if (profile.willingToRelocate != null) ctx.willingToRelocate    = profile.willingToRelocate;
  if (profile.salaryExpectation)        ctx.expectedSalary        = profile.salaryExpectation;
  if (profile.email)                    ctx.email                 = profile.email;
  if (profile.phone)                    ctx.phone                 = profile.phone;
  if (profile.headline)                 ctx.headline              = profile.headline;

  if (Array.isArray(profile.education) && profile.education.length) {
    ctx.education = profile.education;
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Response validator
// ---------------------------------------------------------------------------

/**
 * Validate and normalise the raw AI response.
 * Returns a safe AgentAction or falls back to a stop action.
 *
 * @param {*} raw
 * @param {string} [fallbackReason]
 * @returns {object} AgentAction
 */
export function validateAction(raw, fallbackReason = "invalid AI response") {
  if (!raw || typeof raw !== "object") {
    return { action: "stop", reason: fallbackReason };
  }

  const action = String(raw.action || "").toLowerCase().trim();
  if (!ALLOWED_ACTIONS.has(action)) {
    return { action: "stop", reason: `disallowed action "${raw.action}" — ${fallbackReason}` };
  }

  // Ensure no arbitrary JavaScript or CSS selector fields
  const safe = { action };

  // target must look like element_N or be absent
  if (raw.target != null) {
    const t = String(raw.target).trim();
    if (/^element_\d+$/.test(t)) safe.target = t;
    // Otherwise silently drop it; the executor will report "no target"
  }

  if (raw.value   != null) safe.value    = String(raw.value).slice(0, 4096);
  if (raw.question != null) safe.question = String(raw.question).slice(0, 1024);
  if (raw.reason  != null) safe.reason   = String(raw.reason).slice(0, 512);
  if (typeof raw.confidence === "number") {
    safe.confidence = Math.max(0, Math.min(1, raw.confidence));
  }

  return safe;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  return [
    "You are an AI agent controlling a job application form on behalf of a candidate.",
    "You receive a UISnapshot describing the current state of the application UI,",
    "and a CandidateContext with information about the candidate.",
    "",
    "Your task is to decide the SINGLE NEXT ACTION to take.",
    "",
    "Rules:",
    "1. Only use information from CandidateContext. NEVER invent or assume candidate data.",
    "2. If the answer to a required field is not in CandidateContext, return ask_user.",
    "3. Return ONLY valid JSON matching the action schema. No code, no selectors, no explanations outside the JSON.",
    "4. Use element IDs from the snapshot (e.g. element_1). Never write CSS selectors or XPaths.",
    "5. Prefer deterministic answers: if noticePeriodDays=0 matches '0 - (Immediate Joiner)', select it.",
    "6. Never fabricate answers for visa, disability, criminal, or demographic questions — always ask_user.",
    "7. If the application appears complete (applied marker visible), return finish.",
    "8. If a CAPTCHA or security challenge is detected, return stop.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main decision function
// ---------------------------------------------------------------------------

/**
 * Ask the AI what action to take next given the current UISnapshot.
 *
 * @param {object}   snapshot    UISnapshot from naukriObserver.observe()
 * @param {object}   profile     Full candidate profile from storage
 * @param {Function} askJSON     The askJSON function from the LLM router
 * @returns {Promise<object>}    AgentAction
 */
export async function decideAction(snapshot, profile, askJSON) {
  if (!snapshot || !askJSON) {
    return { action: "stop", reason: "decideAction called without snapshot or askJSON" };
  }

  // Short-circuit: if already done
  if (snapshot.page?.applicationState === "done") {
    return { action: "finish", reason: "Application already submitted" };
  }

  // Short-circuit: loading state
  if (snapshot.loading) {
    return { action: "wait", value: "1500", reason: "Page is loading" };
  }

  const candidateContext = buildCandidateContext(profile);
  const userPrompt = [
    "UISnapshot:",
    JSON.stringify(snapshot, null, 2),
    "",
    "CandidateContext:",
    JSON.stringify(candidateContext, null, 2),
    "",
    "Decide the single next action. Return JSON only.",
  ].join("\n");

  let raw;
  try {
    raw = await askJSON({
      task: "uiAction",
      system: buildSystemPrompt(),
      user: userPrompt,
      schema: ACTION_SCHEMA,
    });
  } catch (err) {
    // Provider error → wait and let the caller retry
    const retryable = err && err.retryable;
    if (retryable) throw err;   // propagate retryable errors so the worker handles them
    return { action: "stop", reason: "AI provider error: " + String(err && err.message ? err.message : err) };
  }

  return validateAction(raw, "AI returned unexpected response");
}
