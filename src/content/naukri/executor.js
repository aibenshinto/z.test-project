// Browser Action Executor + Verification Engine.
//
// Controlled executor: takes a validated AgentAction returned by the AI
// Decision Engine, resolves the element ID, confirms the element exists and
// is interactable, performs the action using existing typing utilities, and
// returns a verified result.
//
// This file NEVER:
//   - accepts arbitrary JavaScript from the AI
//   - accepts CSS selectors from the AI
//   - evaluates any AI-generated string as code
//   - assumes an action succeeded without DOM verification
//
// CRITICAL: radio-button selection must produce checked === true before the
// executor reports success. This is verified independently of the AI's claim.

/* global naukriObserver, naukriType */

// ---------------------------------------------------------------------------
// Element resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an element ID and confirm it is still in the document and visible.
 * @param {string} id  element_N
 * @returns {{ el: Element } | { error: string }}
 */
function resolveTarget(id) {
  if (!id) return { error: "no target element ID provided" };
  if (!/^element_\d+$/.test(id)) return { error: `invalid element ID format: "${id}"` };

  const el = naukriObserver.getElement(id);
  if (!el) return { error: `element "${id}" not found — snapshot may be stale` };

  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) {
    return { error: `element "${id}" is not visible (zero dimensions)` };
  }
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") {
    return { error: `element "${id}" is hidden` };
  }

  return { el };
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

/**
 * Verify a radio/checkbox became checked after interaction.
 * Follows the element or its nearest input[type=radio|checkbox].
 */
function verifyChecked(el) {
  if (el.type === "radio" || el.type === "checkbox") return el.checked === true;
  const input = el.querySelector("input[type='radio'], input[type='checkbox']") ||
                el.closest("label")?.querySelector("input[type='radio'], input[type='checkbox']");
  return input ? input.checked === true : false;
}

/**
 * Verify a text-like element's value matches expected after typing.
 */
function verifyTyped(el, value) {
  const v = String(value);
  const actual = el.isContentEditable
    ? el.textContent.trim()
    : (el.value || "").trim();
  return actual === v.trim();
}

// ---------------------------------------------------------------------------
// Individual action handlers
// ---------------------------------------------------------------------------

async function executeClick(el, id) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  el.focus();
  el.click();
  // For click, we can only verify the element still exists (page may navigate)
  const still = document.contains(el);
  return { success: true, verified: still, action: "click", target: id };
}

async function executeType(el, id, value) {
  if (!value && value !== "0") {
    return { success: false, verified: false, action: "type", target: id, error: "no value to type" };
  }
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const typed = await naukriType.typeInto(el, value);
  const verified = typed && verifyTyped(el, value);
  return { success: typed, verified, action: "type", target: id, value };
}

/**
 * Select a radio option. This is the most critical action for Naukri
 * questionnaires. We try multiple click strategies and verify .checked.
 */
async function executeSelect(el, id) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });

  // Strategy 1: click the radio input itself
  const radioInput = el.type === "radio"
    ? el
    : el.querySelector("input[type='radio']") ||
      el.closest(".ssrc__radio-btn-container, .singleselect-radiobutton")?.querySelector("input[type='radio']");

  if (radioInput && !radioInput.checked) {
    radioInput.click();
    await new Promise((r) => setTimeout(r, 80));
  }

  // Strategy 2: also click the container/label for React event propagation
  if (!verifyChecked(radioInput || el)) {
    const label = el.tagName.toLowerCase() === "label"
      ? el
      : el.closest("label") ||
        el.querySelector(".ssrc__label, [class*='label']");
    if (label) {
      label.click();
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  // Strategy 3: click the container itself
  if (!verifyChecked(radioInput || el)) {
    el.click();
    await new Promise((r) => setTimeout(r, 80));
  }

  const checked = verifyChecked(radioInput || el);
  return { success: checked, verified: checked, action: "select", target: id };
}

async function executeCheck(el, id) {
  if (verifyChecked(el)) {
    return { success: true, verified: true, action: "check", target: id, note: "already checked" };
  }
  el.click();
  await new Promise((r) => setTimeout(r, 80));
  const checked = verifyChecked(el);
  return { success: checked, verified: checked, action: "check", target: id };
}

async function executeUncheck(el, id) {
  if (!verifyChecked(el)) {
    return { success: true, verified: true, action: "uncheck", target: id, note: "already unchecked" };
  }
  el.click();
  await new Promise((r) => setTimeout(r, 80));
  const unchecked = !verifyChecked(el);
  return { success: unchecked, verified: unchecked, action: "uncheck", target: id };
}

async function executeUpload(el, id, resumeFile) {
  if (!resumeFile) {
    return { success: false, verified: false, action: "upload", target: id, error: "no resume file available" };
  }
  const done = naukriType.attachFile(el, resumeFile);
  return { success: done, verified: done, action: "upload", target: id };
}

async function executeWait(value) {
  const ms = Math.min(10000, Math.max(100, parseInt(value, 10) || 1500));
  await new Promise((r) => setTimeout(r, ms));
  return { success: true, verified: true, action: "wait", ms };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute one AgentAction returned by the AI Decision Engine.
 *
 * @param {object} action   Validated AgentAction
 * @param {object} [opts]
 * @param {File}   [opts.resumeFile]  Resume File object for upload actions
 * @returns {Promise<object>}  Execution result
 */
async function executeAction(action, { resumeFile } = {}) {
  const { action: type, target, value, question, reason } = action;

  // ----- Non-DOM actions (no element needed) --------------------------------

  if (type === "wait") {
    return executeWait(value);
  }

  if (type === "finish") {
    return { success: true, verified: true, action: "finish", finish: true };
  }

  if (type === "stop") {
    return {
      success: false, verified: true, action: "stop", stopped: true,
      reason: reason || "AI requested stop",
    };
  }

  if (type === "ask_user") {
    return {
      success: false, verified: true, action: "ask_user",
      waitingForUser: true,
      question: question || "Additional information needed",
    };
  }

  // ----- DOM actions (element required) ------------------------------------

  const resolved = resolveTarget(target);
  if (resolved.error) {
    return { success: false, verified: false, action: type, target, error: resolved.error };
  }
  const { el } = resolved;

  switch (type) {
    case "click":   return executeClick(el, target);
    case "type":    return executeType(el, target, value);
    case "select":  return executeSelect(el, target);
    case "check":   return executeCheck(el, target);
    case "uncheck": return executeUncheck(el, target);
    case "upload":  return executeUpload(el, target, resumeFile);
    default:
      return { success: false, verified: false, action: type, error: `unhandled action type: "${type}"` };
  }
}

globalThis.naukriExecutor = { executeAction };
