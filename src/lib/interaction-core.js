// Interaction core — pure, DOM-free decision logic shared by every adapter.
//
// This module exists so the rules that decide "did the website actually react?"
// can be unit-tested with `node --test` without a browser. The content-script
// side (src/content/shared/*.js) supplies real DOM facts; this module turns
// those facts into verdicts.
//
// The governing principle: executing an action is NOT the same as the website
// accepting it. `element.click()` returning without throwing tells us only that
// JavaScript ran. Only an observed state transition tells us the site reacted.

// ---------------------------------------------------------------------------
// Action result vocabulary
// ---------------------------------------------------------------------------

/**
 * ACTION_EXECUTED  — the interaction was performed; the site's reaction is not
 *                    yet known. Never report this to the user as success.
 * ACTION_CONFIRMED — the interaction was performed AND the page state changed
 *                    in a way consistent with the action being accepted.
 * ACTION_NO_EFFECT — the interaction was performed and the page did not change.
 * ACTION_FAILED    — the interaction could not be performed at all.
 * ACTION_STALE     — the target no longer matches the observed element.
 */
export const ACTION_RESULT = Object.freeze({
  EXECUTED: "ACTION_EXECUTED",
  CONFIRMED: "ACTION_CONFIRMED",
  NO_EFFECT: "ACTION_NO_EFFECT",
  FAILED: "ACTION_FAILED",
  STALE: "ACTION_STALE",
});

/**
 * Application-level outcome. Distinct from action results: a click can be
 * CONFIRMED while the application as a whole is still UNKNOWN.
 */
export const APPLICATION_STATUS = Object.freeze({
  SUBMITTED: "APPLICATION_SUBMITTED",
  UNKNOWN: "APPLICATION_STATUS_UNKNOWN",
  NOT_SUBMITTED: "APPLICATION_NOT_SUBMITTED",
});

/** Click retry budget before the agent escalates to the LLM / the user. */
export const MAX_CLICK_RETRIES = 3;

// ---------------------------------------------------------------------------
// Apply-intent recognition
// ---------------------------------------------------------------------------

// Phrases that start or advance an application. Deliberately broader than the
// old `apply|easy apply` test: a site may say "Start application" or
// "Get started" and never use the word "apply" at all.
//
// This is a HINT used for ranking candidates in the snapshot, never a filter
// that removes elements from the LLM's view. See observer-core.rankApplyIntent.
const APPLY_INTENT_PATTERNS = [
  /\beasy\s*apply\b/i,
  /\bapply\s*now\b/i,
  /\bapply\b/i,
  /\bapplication\b/i,
  /\bstart\s+(?:your\s+)?applic/i,
  /\bstart\s+applying\b/i,
  /\bbegin\s+(?:your\s+)?applic/i,
  /\bcontinue\s+(?:your\s+)?applic/i,
  /\bsubmit\s+(?:your\s+)?applic/i,
  /\bget\s+started\b/i,
  /\bstart\b/i,
  /\bproceed\b/i,
  /\bcontinue\b/i,
  /\bnext(?:\s+step)?\b/i,
];

// Strong signals score higher than weak generic ones like "start".
const STRONG_APPLY_PATTERNS = [
  /\beasy\s*apply\b/i,
  /\bapply\s*now\b/i,
  /\bapply\s+to\s+this\s+job\b/i,
  /\bstart\s+(?:your\s+)?applic/i,
  /\bbegin\s+(?:your\s+)?applic/i,
  /\bcontinue\s+(?:your\s+)?applic/i,
];

/**
 * Collect every piece of text that could name a control, not just innerText.
 * A button can be `<button aria-label="Easy Apply">` with no text at all.
 *
 * @param {object} el  Element descriptor (see observer-core.describe)
 * @returns {string}   Space-joined searchable text
 */
export function accessibleName(el) {
  if (!el) return "";
  return [el.text, el.ariaLabel, el.title, el.value, el.name, el.placeholder]
    .filter((s) => typeof s === "string" && s.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Score how likely an element descriptor is to be the control that starts or
 * advances a job application. 0 means "no apply intent detected".
 *
 * Text is only one input. An element with no text but
 * `aria-label="Easy Apply"` scores exactly as highly as a text one, which is
 * the Part 4 requirement.
 *
 * @param {object} el  Element descriptor
 * @returns {number}   0..1
 */
export function rankApplyIntent(el) {
  const name = accessibleName(el);
  if (!name) return 0;

  let score = 0;
  if (STRONG_APPLY_PATTERNS.some((re) => re.test(name))) score = 0.9;
  else if (APPLY_INTENT_PATTERNS.some((re) => re.test(name))) score = 0.5;
  if (!score) return 0;

  // Semantics: a real <button> or role=button is a likelier target than a
  // paragraph that happens to contain the word "apply".
  const tag = String(el.tag || "").toLowerCase();
  const role = String(el.role || "").toLowerCase();
  if (tag === "button" || role === "button" || tag === "a" || role === "link") {
    score += 0.1;
  }

  // A disabled control is visible but cannot be the next action.
  if (el.disabled || el.enabled === false) score *= 0.3;
  if (el.visible === false) score *= 0.2;

  return Math.max(0, Math.min(1, score));
}

/**
 * Pick the best apply-intent candidates from a snapshot's element list.
 * Returns them ranked, so logs can say "Candidate Apply button: element_12".
 *
 * @param {object[]} elements
 * @param {number} [limit=5]
 * @returns {Array<{id:string, name:string, score:number}>}
 */
export function findApplyCandidates(elements, limit = 5) {
  if (!Array.isArray(elements)) return [];
  return elements
    .map((el) => ({ id: el.id, name: accessibleName(el), score: rankApplyIntent(el) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Page-state fingerprinting and comparison
// ---------------------------------------------------------------------------

/**
 * Reduce a page fingerprint to the fields that indicate a real transition.
 * The content script builds these; keeping the comparison here makes it
 * testable and keeps all three adapters honest in the same way.
 *
 * Fingerprint shape:
 *   { url, title, modalOpen, controlCount, fieldCount, bodyTextHash,
 *     visibleTexts: string[], applicationState, errorCount }
 */

/**
 * Compare two page fingerprints and describe what changed.
 *
 * @param {object} before
 * @param {object} after
 * @returns {{changed: boolean, changes: string[]}}
 */
export function diffPageState(before, after) {
  const changes = [];
  if (!before || !after) return { changed: false, changes };

  if (before.url !== after.url) changes.push("url");
  if (before.title !== after.title) changes.push("title");
  if (Boolean(before.modalOpen) !== Boolean(after.modalOpen)) changes.push("modal");
  if (before.applicationState !== after.applicationState) changes.push("applicationState");
  if (before.bodyTextHash !== after.bodyTextHash) changes.push("content");

  // A changed control/field count means new UI appeared (form step, dialog).
  if (Number(before.controlCount) !== Number(after.controlCount)) changes.push("controlCount");
  if (Number(before.fieldCount) !== Number(after.fieldCount)) changes.push("fieldCount");
  if (Number(before.errorCount ?? 0) !== Number(after.errorCount ?? 0)) changes.push("errors");

  return { changed: changes.length > 0, changes };
}

// ---------------------------------------------------------------------------
// Success indicators
// ---------------------------------------------------------------------------

// Indicators that an application reached a terminal submitted state. Matching
// one of these is necessary but, on its own, still only "evidence" — see
// classifyApplicationStatus.
// Phrases that prove THIS application was submitted.
//
// These are matched against whole-page text, which on a job board also
// contains other jobs' statuses ("Application sent 2 days ago" in a sidebar
// rail) and step counters ("Application complete 3 of 5"). Matching those
// would mark a job submitted that never was — the worst failure this system
// can produce — so the patterns are anchored to first-person confirmation
// wording and the bare "application complete/sent" forms are excluded.
const SUBMISSION_PATTERNS = [
  /\byour application (?:was|has been) (?:sent|submitted|received)\b/i,
  /\bapplication (?:was|has been) (?:submitted|sent|received)\b/i,
  // Bare banner wording ("Application submitted"). Kept because it is the
  // most common confirmation of all; the disqualifiers below are what stop a
  // sidebar rail or a step counter from matching it.
  /\bapplication (?:submitted|received)\b/i,
  /\bthank you for applying\b/i,
  /\bthank you for your application\b/i,
  /\bwe(?:'|’)?ve received your application\b/i,
  /\bwe have received your application\b/i,
  /\byour application is complete\b/i,
  /\bsuccessfully submitted\b/i,
  /\bapplication submitted successfully\b/i,
  /\bapplication confirmation\b/i,
];

// Wording that looks like confirmation but is about a DIFFERENT job, or is a
// step counter. If one of these matches at the position of a would-be
// submission match, the evidence is rejected.
const SUBMISSION_DISQUALIFIERS = [
  // "Application sent 2 days ago" — a past application listed elsewhere.
  /\bapplication (?:was |has been )?(?:sent|submitted|received)\b[^.]{0,20}\b\d+\s*(?:second|minute|hour|day|week|month)s?\s+ago\b/i,
  // "Application complete 3 of 5", "Step 2 of 4"
  /\b\d+\s+of\s+\d+\b/i,
  // Sidebar rails that list other jobs.
  /\b(?:similar|recommended|related|other|more)\s+jobs?\b/i,
  /\bpeople also (?:viewed|applied)\b/i,
];

// Indicators that the flow PROGRESSED but did not finish. Treating these as
// submission is the Part 21 false-positive we must avoid.
const PROGRESS_PATTERNS = [
  /\bnext\b/i,
  /\breview\b/i,
  /\bcontinue\b/i,
  /\bsubmit application\b/i,
  /\bapplication sent\?*$/i,
];

/**
 * Does this text prove the application was submitted?
 * @param {string} text
 * @returns {boolean}
 */
export function hasSubmissionEvidence(text) {
  if (!text) return false;

  for (const re of SUBMISSION_PATTERNS) {
    const match = re.exec(text);
    if (!match) continue;

    // Judge the phrase in its immediate neighbourhood, not against the whole
    // page: a confirmation banner at the top must not be disqualified by a
    // "Similar jobs" rail 2000 characters below it.
    const from = Math.max(0, match.index - 60);
    const context = text.slice(from, match.index + match[0].length + 60);

    if (SUBMISSION_DISQUALIFIERS.some((bad) => bad.test(context))) continue;
    return true;
  }
  return false;
}

/**
 * Does this text merely show the flow advanced a step?
 * @param {string} text
 * @returns {boolean}
 */
export function hasProgressEvidence(text) {
  if (!text) return false;
  return PROGRESS_PATTERNS.some((re) => re.test(text));
}

/**
 * Decide whether an application may be reported as submitted.
 *
 * Refuses to claim submission on weak evidence. "The Apply button was clicked"
 * and "the modal opened" are NOT submission. An adapter's own authoritative
 * check (`adapterConfirmed`, e.g. naukriApplicationSubmitted()) is.
 *
 * @param {object} evidence
 * @param {boolean} [evidence.adapterConfirmed]  Platform-specific proof
 * @param {string}  [evidence.pageText]          Visible page text after the flow
 * @param {string[]} [evidence.successIndicators] Observed success elements
 * @param {boolean} [evidence.agentClaimedFinish] The LLM said "finish"
 * @returns {{status: string, reason: string}}
 */
export function classifyApplicationStatus(evidence = {}) {
  const {
    adapterConfirmed = false,
    pageText = "",
    successIndicators = [],
    agentClaimedFinish = false,
  } = evidence;

  if (adapterConfirmed) {
    return {
      status: APPLICATION_STATUS.SUBMITTED,
      reason: "Confirmed by the platform adapter's own submission check",
    };
  }

  const indicatorText = (successIndicators || []).join(" ");
  if (hasSubmissionEvidence(pageText) || hasSubmissionEvidence(indicatorText)) {
    return {
      status: APPLICATION_STATUS.SUBMITTED,
      reason: "Confirmed by an explicit submission confirmation message",
    };
  }

  // Wording that shows the flow advanced is worth reporting distinctly from
  // silence: "Next"/"Review" means the agent is mid-flow, not finished.
  if (hasProgressEvidence(pageText)) {
    return {
      status: APPLICATION_STATUS.UNKNOWN,
      reason: agentClaimedFinish
        ? "The agent reported finish, but the page still shows application steps rather than a confirmation"
        : "The application appears to be in progress; no submission confirmation was found",
    };
  }

  // The model saying "finish" is a claim, not proof.
  if (agentClaimedFinish) {
    return {
      status: APPLICATION_STATUS.UNKNOWN,
      reason: "The agent reported finish but no submission confirmation was found on the page",
    };
  }

  return {
    status: APPLICATION_STATUS.UNKNOWN,
    reason: "No submission confirmation was observed",
  };
}

// ---------------------------------------------------------------------------
// Click verification
// ---------------------------------------------------------------------------

/**
 * Classify what a click actually achieved, given before/after fingerprints.
 *
 * This is the heart of Part 7, 10 and 11: a click that ran without throwing
 * but left the page identical is ACTION_NO_EFFECT, never success.
 *
 * @param {object} params
 * @param {boolean} params.executed        The interaction was dispatched
 * @param {object}  params.before          Page fingerprint before
 * @param {object}  params.after           Page fingerprint after
 * @param {boolean} [params.targetGone]    Target left the DOM (often success:
 *                                         a modal replaced it)
 * @returns {{result: string, changes: string[], reason: string}}
 */
export function classifyClickOutcome({ executed, before, after, targetGone = false }) {
  if (!executed) {
    return { result: ACTION_RESULT.FAILED, changes: [], reason: "the click could not be dispatched" };
  }

  const { changed, changes } = diffPageState(before, after);

  // Text drifting on its own (a lazy-loaded rail, a badge) is not proof the
  // click was accepted. Require a structural change — navigation, a dialog, a
  // different set of controls — or text change accompanied by one.
  const STRUCTURAL = ["url", "title", "modal", "applicationState", "controlCount", "fieldCount", "errors"];
  const structural = changes.filter((c) => STRUCTURAL.includes(c));

  if (structural.length) {
    return {
      result: ACTION_RESULT.CONFIRMED,
      changes,
      reason: `the page changed (${changes.join(", ")})`,
    };
  }

  // The clicked node disappearing is itself a reaction — React swapped the UI.
  if (targetGone) {
    return {
      result: ACTION_RESULT.CONFIRMED,
      changes: ["targetRemoved"],
      reason: "the target element was removed from the page after the click",
    };
  }

  return {
    result: ACTION_RESULT.NO_EFFECT,
    changes,
    reason: changes.length
      ? `the click was dispatched but only incidental content changed (${changes.join(", ")})`
      : "the click was dispatched but the page did not change",
  };
}

/**
 * Decide what to do after a click attempt.
 *
 * Escalation ladder (Part 12):
 *   attempt 0 failed → retry with a real pointer sequence
 *   attempt 1 failed → re-observe and re-resolve, pointer again
 *   attempt >= MAX   → hand back to the LLM, then to the user
 *
 * @param {string} outcome   ACTION_RESULT value
 * @param {number} attempt   0-based attempt index just completed
 * @param {number} [maxRetries=MAX_CLICK_RETRIES]
 * @returns {{next: string, method: string|null}}
 */
export function nextClickStrategy(outcome, attempt, maxRetries = MAX_CLICK_RETRIES) {
  if (outcome === ACTION_RESULT.CONFIRMED) {
    return { next: "continue", method: null };
  }
  if (attempt + 1 >= maxRetries) {
    return { next: "reassess", method: null };
  }
  if (outcome === ACTION_RESULT.STALE) {
    return { next: "retry", method: "reresolve_then_pointer" };
  }
  // NO_EFFECT or FAILED → escalate the interaction method.
  return { next: "retry", method: attempt === 0 ? "pointer_click" : "reresolve_then_pointer" };
}

// ---------------------------------------------------------------------------
// Pointer geometry
// ---------------------------------------------------------------------------

/**
 * Compute the point to aim a pointer sequence at, from the element's CURRENT
 * bounding rect. Never a hardcoded screen coordinate (Part 8).
 *
 * Clamps to the viewport so a partially offscreen element still gets a point
 * the browser will accept.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{width:number,height:number}} [viewport]
 * @returns {{x:number, y:number} | null}
 */
export function pointerPointFor(rect, viewport) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;

  let x = rect.x + rect.width / 2;
  let y = rect.y + rect.height / 2;

  if (viewport && viewport.width > 0 && viewport.height > 0) {
    // An element lying wholly outside the viewport cannot be pointed at; the
    // caller must scroll first. One that merely straddles an edge is still
    // clickable, so aim at the centre of its visible part rather than refusing.
    const right = rect.x + rect.width;
    const bottom = rect.y + rect.height;
    if (right <= 0 || bottom <= 0 || rect.x >= viewport.width || rect.y >= viewport.height) {
      return null;
    }
    x = (Math.max(rect.x, 0) + Math.min(right, viewport.width)) / 2;
    y = (Math.max(rect.y, 0) + Math.min(bottom, viewport.height)) / 2;
    x = Math.min(Math.max(x, 1), viewport.width - 1);
    y = Math.min(Math.max(y, 1), viewport.height - 1);
  }

  return { x: Math.round(x), y: Math.round(y) };
}

// ---------------------------------------------------------------------------
// Stale-target detection
// ---------------------------------------------------------------------------

/**
 * Compare the metadata captured at observe time against the element's live
 * facts to decide whether the reference is still the control we meant.
 *
 * Position is deliberately NOT part of this test: pages scroll, and a scrolled
 * button is the same button. Identity comes from semantics.
 *
 * @param {object} expected  Metadata recorded at observe time
 * @param {object} actual    Metadata read from the live node now
 * @returns {{stale: boolean, reason: string}}
 */
export function isStaleTarget(expected, actual) {
  if (!actual || actual.connected === false) {
    return { stale: true, reason: "element is no longer attached to the document" };
  }
  if (!expected) return { stale: false, reason: "" };

  if (expected.tag && actual.tag && expected.tag !== actual.tag) {
    return { stale: true, reason: `tag changed from ${expected.tag} to ${actual.tag}` };
  }
  if (expected.role && actual.role && expected.role !== actual.role) {
    return { stale: true, reason: `role changed from ${expected.role} to ${actual.role}` };
  }

  // Text is compared loosely: a count badge changing ("Next" → "Next (2)")
  // should not be treated as a different control.
  const wanted = normalizeText(accessibleName(expected));
  const got = normalizeText(accessibleName(actual));
  if (wanted && got && !got.includes(wanted) && !wanted.includes(got)) {
    return { stale: true, reason: `label changed from "${wanted}" to "${got}"` };
  }

  if (actual.rect && !(actual.rect.width > 0 && actual.rect.height > 0)) {
    return { stale: true, reason: "element no longer has a visible bounding box" };
  }

  return { stale: false, reason: "" };
}

function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Score how well a live candidate element matches the metadata of the element
 * the LLM originally chose. Used to re-resolve `element_12` after a rerender
 * (Part 3) — the ID is a logical target, not a permanent DOM pointer.
 *
 * @param {object} expected  Metadata recorded at observe time
 * @param {object} candidate Metadata of a live element
 * @returns {number} 0..1
 */
export function scoreCandidateMatch(expected, candidate) {
  if (!expected || !candidate) return 0;

  const wantedName = normalizeText(accessibleName(expected));
  const candName = normalizeText(accessibleName(candidate));

  let score = 0;

  // Accessible name is the strongest identity signal.
  if (wantedName && candName) {
    if (wantedName === candName) score += 0.5;
    else if (candName.includes(wantedName) || wantedName.includes(candName)) score += 0.3;
    else return 0; // A different label is a different control.
  } else if (wantedName || candName) {
    // One has a name and the other does not: not the same control.
    return 0;
  } else {
    // Neither has an accessible name. Two unlabelled text inputs are
    // indistinguishable by semantics, and guessing between them would silently
    // type into the wrong field. Require a positional identity instead.
    if (!expected.rect || !candidate.rect) return 0;
    const dx = Math.abs((expected.rect.x || 0) - (candidate.rect.x || 0));
    const dy = Math.abs((expected.rect.y || 0) - (candidate.rect.y || 0));
    if (dx > 8 || dy > 8) return 0;
    score += 0.5;
  }

  if (expected.tag && candidate.tag && expected.tag === candidate.tag) score += 0.15;
  if (expected.role && candidate.role && expected.role === candidate.role) score += 0.15;
  if (expected.type && candidate.type && expected.type === candidate.type) score += 0.1;
  if (expected.name && candidate.name && expected.name === candidate.name) score += 0.1;

  // Proximity is a weak tie-breaker only — never an identity test.
  if (expected.rect && candidate.rect) {
    const dx = Math.abs((expected.rect.x || 0) - (candidate.rect.x || 0));
    const dy = Math.abs((expected.rect.y || 0) - (candidate.rect.y || 0));
    if (dx < 120 && dy < 120) score += 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Choose the best live element to stand in for a logical target.
 *
 * @param {object} expected      Metadata recorded at observe time
 * @param {object[]} candidates  Live element metadata, each with an `id`
 * @param {number} [threshold=0.45]
 * @returns {{id: string, score: number} | null}
 */
export function resolveLogicalTarget(expected, candidates, threshold = 0.45) {
  if (!expected || !Array.isArray(candidates)) return null;
  let best = null;
  for (const cand of candidates) {
    const score = scoreCandidateMatch(expected, cand);
    if (score < threshold) continue;
    // Equal scores mean identical-looking controls, such as one "Apply" per
    // row of a job list. The nearest is the one we meant; the first in the
    // document is usually a different row.
    const distance = rectDistance(expected.rect, cand.rect);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = { id: cand.id, score, distance };
    }
  }
  return best && { id: best.id, score: best.score };
}

function rectDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
}

// ---------------------------------------------------------------------------
// Security / CAPTCHA policy
// ---------------------------------------------------------------------------

const SECURITY_PATTERNS = [
  /\bcaptcha\b/i,
  /\brecaptcha\b/i,
  /\bhcaptcha\b/i,
  /\bturnstile\b/i,
  /\bverify (?:you are|you're) (?:a )?human\b/i,
  /\bi'?m not a robot\b/i,
  /\bsecurity (?:check|challenge|verification)\b/i,
  /\bsuspicious activity\b/i,
  /\bunusual activity\b/i,
  /\bare you a robot\b/i,
  /\baccess denied\b/i,
  /\bchallenge required\b/i,
];

/**
 * Detect a security challenge from observed signals.
 *
 * When this returns blocked, the agent MUST stop and hand off to the user.
 * Pointer interaction exists to drive ordinary controls reliably; it is never
 * to be used to work around one of these (Part 9).
 *
 * @param {object} signals
 * @param {string} [signals.pageText]
 * @param {string[]} [signals.frameSources]
 * @param {boolean} [signals.passwordFieldVisible]
 * @returns {{blocked: boolean, kind: string|null, reason: string}}
 */
export function detectSecurityChallenge(signals = {}) {
  const { pageText = "", frameSources = [], passwordFieldVisible = false } = signals;

  for (const src of frameSources) {
    if (/recaptcha|hcaptcha|turnstile|captcha|checkpoint/i.test(String(src))) {
      return {
        blocked: true,
        kind: "captcha",
        reason: "A CAPTCHA or security challenge frame is present. The agent will not attempt to solve or bypass it.",
      };
    }
  }

  if (SECURITY_PATTERNS.some((re) => re.test(pageText))) {
    return {
      blocked: true,
      kind: "challenge",
      reason: "A security or verification challenge was detected. The agent will not attempt to bypass it.",
    };
  }

  if (passwordFieldVisible && /\bsign in\b|\blog ?in\b/i.test(pageText)) {
    return {
      blocked: true,
      kind: "login",
      reason: "A login wall was detected. Please sign in manually, then resume.",
    };
  }

  return { blocked: false, kind: null, reason: "" };
}
