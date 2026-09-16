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

// Every action the model may request. Existing actions are retained verbatim;
// the additions make this a general browser agent rather than a form filler.
//
// Deliberately absent, and never to be added: any action that executes a
// model-supplied string as code (eval, Function, javascript: URLs, injected
// script, arbitrary CSS selectors). The model addresses the page only through
// element_N identifiers it was shown.
const ALLOWED_ACTIONS = new Set([
  // Original vocabulary — unchanged.
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
  // General browser actions.
  "double_click",
  "key_press",
  "scroll",
  "scroll_to",
  "go_back",
  "go_forward",
  "navigate",
  "switch_tab",
  "open_tab",
  "close_tab",
]);

/** Keys the model may press. Anything else is rejected by validateAction. */
const ALLOWED_KEYS = new Set([
  "ENTER", "TAB", "ESCAPE", "ESC", "SPACE", "BACKSPACE", "DELETE",
  "ARROWUP", "ARROWDOWN", "ARROWLEFT", "ARROWRIGHT",
  "HOME", "END", "PAGEUP", "PAGEDOWN",
]);

const ALLOWED_DIRECTIONS = new Set(["up", "down", "left", "right"]);

/** Only http(s) navigation. Blocks javascript:, data:, file: and friends. */
function safeUrl(raw) {
  try {
    const url = new URL(String(raw));
    return (url.protocol === "https:" || url.protocol === "http:") ? url.href : null;
  } catch (_) {
    return null;
  }
}

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
    key: {
      type: "string",
      description: "For key_press: one of ENTER, TAB, ESCAPE, SPACE, BACKSPACE, DELETE, ARROWUP, ARROWDOWN, ARROWLEFT, ARROWRIGHT, HOME, END, PAGEUP, PAGEDOWN.",
    },
    direction: {
      type: "string",
      enum: ["up", "down", "left", "right"],
      description: "For scroll: which way to scroll.",
    },
    amount: {
      type: "number",
      description: "For scroll: distance in pixels (50-5000).",
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

  // key_press: only named keys from the allow-list.
  if (action === "key_press") {
    const key = String(raw.key ?? raw.value ?? "").toUpperCase().trim();
    if (!ALLOWED_KEYS.has(key)) {
      return { action: "stop", reason: `unsupported key "${raw.key ?? raw.value}" — ${fallbackReason}` };
    }
    safe.key = key;
  }

  // scroll: bounded direction and distance.
  if (action === "scroll") {
    const dir = String(raw.direction || "down").toLowerCase().trim();
    safe.direction = ALLOWED_DIRECTIONS.has(dir) ? dir : "down";
    const amount = Number(raw.amount ?? raw.value ?? 600);
    safe.amount = Number.isFinite(amount) ? Math.min(5000, Math.max(50, Math.abs(amount))) : 600;
  }

  // navigate / open_tab: http(s) only. A javascript: or data: URL is code
  // execution by another name, so an unsafe URL fails the whole action.
  if (action === "navigate" || action === "open_tab") {
    const url = safeUrl(raw.value ?? raw.url);
    if (!url) {
      return { action: "stop", reason: `unsafe or missing URL for ${action} — ${fallbackReason}` };
    }
    safe.value = url;
  }

  return safe;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  return [
    "You are a browser agent operating a web page on behalf of a job candidate.",
    "You receive a UISnapshot describing the interactive controls currently visible,",
    "a CandidateContext describing the candidate, and sometimes a screenshot of the",
    "viewport. Your task is to decide the SINGLE NEXT ACTION to take.",
    "",
    "Available actions:",
    "  click, double_click, type, key_press, scroll, scroll_to, select, check,",
    "  uncheck, upload, go_back, go_forward, navigate, switch_tab, open_tab,",
    "  close_tab, wait, ask_user, finish, stop",
    "",
    "Addressing the page:",
    "1. Refer to controls ONLY by the element IDs in the snapshot (e.g. element_1).",
    "   Never write CSS selectors, XPaths, JavaScript, or coordinates.",
    "2. The snapshot lists every visible interactive control, not just form fields.",
    "   An element may have no visible text but still be the right target — check",
    "   its ariaLabel and title. `<button aria-label=\"Easy Apply\">` is an Apply button.",
    "3. applyCandidates ranks controls that look like they start or advance an",
    "   application. It is a hint, not an instruction: a control may be the right",
    "   one even if it is not listed, and wording varies ('Start application',",
    "   'Get started', 'Continue application', 'Apply now').",
    "",
    "Choosing an option:",
    "4. A dropdown has `options` (a list of strings): select it with",
    "   { action: 'select', target: <the dropdown's id>, value: '<option text>' }.",
    "   A radio group has `radioOptions` (objects with their own id and label):",
    "   select it with { action: 'select', target: <the group's id>, value: '<label>' },",
    "   or by targeting one option's id directly. Always name the option you want —",
    "   omitting value selects the first one.",
    "",
    "Answering questions:",
    "5. Only use information from CandidateContext. NEVER invent candidate data.",
    "6. If a required answer is not in CandidateContext, return ask_user.",
    "7. Never fabricate answers for visa, disability, criminal, or demographic",
    "   questions — always ask_user.",
    "",
    "Judging progress:",
    "8. If lastFailure is present, the action described there was executed but the",
    "   website did not react. Do NOT simply repeat it. Choose a different control,",
    "   scroll to reveal more of the page, or ask_user.",
    "9. Return finish ONLY when the page shows an explicit confirmation that the",
    "   application was submitted. A dialog opening, a step advancing, or a button",
    "   changing is progress, not submission.",
    "10. If a CAPTCHA, robot check, or security challenge is present, return stop.",
    "    Never attempt to solve or work around one.",
    "",
    "Return ONLY valid JSON matching the action schema.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main decision function
// ---------------------------------------------------------------------------

/**
 * Ask the AI what action to take next given the current UISnapshot.
 *
 * @param {object}   snapshot    UISnapshot from an adapter's observe()
 * @param {object}   profile     Full candidate profile from storage
 * @param {Function} askJSON     The askJSON function from the LLM router
 * @returns {Promise<object>}    AgentAction
 */
/**
 * Strip a snapshot down to what the model needs.
 *
 * The raw snapshot carries fingerprints and per-element bookkeeping that cost
 * tokens without helping the decision. Rects are kept — the model uses them to
 * reason about layout — but rounded, and empty fields are dropped entirely.
 *
 * @param {object} snapshot
 * @returns {object} compact snapshot
 */
export function compactSnapshot(snapshot) {
  if (!snapshot) return snapshot;

  const elements = (snapshot.elements || snapshot.controls || []).map((el) => {
    const out = { id: el.id, tag: el.tag, role: el.role };
    if (el.type) out.type = el.type;
    if (el.text) out.text = String(el.text).slice(0, 160);
    if (el.ariaLabel) out.ariaLabel = el.ariaLabel;
    if (el.title) out.title = el.title;
    if (el.placeholder) out.placeholder = el.placeholder;
    if (el.name) out.name = el.name;
    if (el.value) out.value = String(el.value).slice(0, 160);
    if (el.selectedText) out.selectedText = el.selectedText;
    // A dropdown's options are plain strings; a radio group's are objects with
    // their own element IDs. Emitting both under one key invites the model to
    // address a radio group the way it addresses a dropdown, which used to
    // select the wrong option. Keep the two shapes under distinct names.
    if (el.options) {
      if (el.role === "radiogroup") out.radioOptions = el.options;
      else out.options = el.options;
    }
    if (el.checked != null) out.checked = el.checked;
    if (el.disabled) out.disabled = true;
    if (el.rect) out.rect = el.rect;
    return out;
  });

  const out = {
    page: snapshot.page,
    elements,
  };
  if (snapshot.questions?.length) out.questions = snapshot.questions;
  if (snapshot.applyCandidates?.length) out.applyCandidates = snapshot.applyCandidates;
  if (snapshot.errors?.length) out.errors = snapshot.errors;
  if (snapshot.successIndicators?.length) out.successIndicators = snapshot.successIndicators;
  if (snapshot.messages?.length) out.messages = snapshot.messages;
  if (snapshot.loading) out.loading = true;
  return out;
}

/**
 * Ask the AI what action to take next.
 *
 * @param {object}   snapshot  UISnapshot from an adapter's observe()
 * @param {object}   profile   Full candidate profile from storage
 * @param {Function} askJSON   The askJSON function from the LLM router
 * @param {object}   [opts]
 * @param {string}   [opts.screenshot]   data: URL of the viewport, when the DOM
 *                                       alone was insufficient
 * @param {object}   [opts.lastFailure]  The action that produced no effect
 * @returns {Promise<object>} AgentAction
 */
export async function decideAction(snapshot, profile, askJSON, opts = {}) {
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
  const parts = [
    "UISnapshot:",
    JSON.stringify(compactSnapshot(snapshot), null, 2),
    "",
    "CandidateContext:",
    JSON.stringify(candidateContext, null, 2),
  ];

  // Which job this application is for. A company careers page can list many
  // openings, each with its own Apply, and a form may ask for the position.
  if (opts.job?.title) {
    parts.push(
      "",
      "ApplyingFor:",
      JSON.stringify({ title: opts.job.title, company: opts.job.company || null }),
      "Act only on this job. If the page lists other openings but not this one, stop.",
    );
  }

  // Feedback from a previous action the website ignored. Without this the
  // model has no way to know its last choice was rejected and will repeat it.
  if (opts.lastFailure) {
    parts.push(
      "",
      "PreviousActionFailed:",
      JSON.stringify(opts.lastFailure, null, 2),
      "The action above was executed but the website did not react to it.",
      "Choose a different approach.",
    );
  }

  if (opts.screenshot) {
    parts.push(
      "",
      "A screenshot of the current viewport is attached. Use it when the DOM",
      "snapshot is ambiguous — a control visible in the image but missing from",
      "the snapshot is still real, and you can scroll to bring it into reach.",
    );
  }

  parts.push("", "Decide the single next action. Return JSON only.");

  let raw;
  try {
    raw = await askJSON({
      task: "uiAction",
      system: buildSystemPrompt(),
      user: parts.join("\n"),
      schema: ACTION_SCHEMA,
      // Reuses the existing multimodal `file` convention of the LLM router.
      file: opts.screenshot || undefined,
    });
  } catch (err) {
    // Provider error → wait and let the caller retry
    const retryable = err && err.retryable;
    if (retryable) throw err;   // propagate retryable errors so the worker handles them
    return { action: "stop", reason: "AI provider error: " + String(err && err.message ? err.message : err) };
  }

  return validateAction(raw, "AI returned unexpected response");
}
