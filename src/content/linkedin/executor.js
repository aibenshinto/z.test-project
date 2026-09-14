// LinkedIn Browser Action Executor + Verification Engine.
//
// Controlled executor: takes a validated AgentAction returned by the AI
// Decision Engine, resolves the element ID from the LinkedIn observer
// registry, confirms the element exists and is interactable, performs the
// action, and returns a verified result.
//
// Before each DOM action the visual highlight ring is flashed so the user
// can watch the agent navigate in real time.
//
// This file NEVER:
//   - accepts arbitrary JavaScript from the AI
//   - accepts CSS selectors from the AI
//   - evaluates any AI-generated string as code
//   - assumes an action succeeded without DOM verification
//
// LinkedIn-specific quirks handled:
//   - React synthetic events required for inputs / textareas
//   - artdeco-dropdown typeahead for combobox controls
//   - Multi-step wizard navigation via named buttons (Next / Review / Submit)

/* global linkedinObserver, __autoApplyHighlight */

// ---------------------------------------------------------------------------
// Typing utilities (React-compatible, no external dependency)
// ---------------------------------------------------------------------------

const ReactDescriptor = {
  input:    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,    "value"),
  textarea: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"),
};

function setNativeValue(el, value) {
  const desc = el.tagName === "TEXTAREA" ? ReactDescriptor.textarea : ReactDescriptor.input;
  if (desc && desc.set) {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
}

async function typeInto(el, value) {
  el.focus();
  el.select?.();
  setNativeValue(el, value);
  el.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.blur();
  await tick(80);
  return String(el.value || "").trim() === String(value).trim();
}

function attachFile(fileInput, { b64, name, mime }) {
  if (!b64 || !name) return false;
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file  = new File([bytes], name, { type: mime || "application/pdf" });
    const dt    = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    return fileInput.files.length === 1;
  } catch (_) {
    return false;
  }
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Element resolution
// ---------------------------------------------------------------------------

function resolveTarget(id) {
  if (!id) return { error: "no target element ID provided" };
  if (!/^element_\d+$/.test(id)) return { error: `invalid element ID format: "${id}"` };

  const el = linkedinObserver.getElement(id);
  if (!el) return { error: `element "${id}" not found — snapshot may be stale` };

  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { error: `element "${id}" is not visible (zero dimensions)` };
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return { error: `element "${id}" is hidden` };

  return { el };
}

// ---------------------------------------------------------------------------
// Highlight helper (no-op if shared module not loaded)
// ---------------------------------------------------------------------------

async function highlight(el, actionType, ms = 500) {
  try {
    if (globalThis.__autoApplyHighlight) {
      await globalThis.__autoApplyHighlight.highlightElement(el, actionType, ms);
    }
  } catch (_) { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

function verifyChecked(el) {
  if (el.type === "radio" || el.type === "checkbox") return el.checked === true;
  const input = el.querySelector("input[type='radio'], input[type='checkbox']") ||
                el.closest("label")?.querySelector("input[type='radio'], input[type='checkbox']");
  return input ? input.checked === true : false;
}

function verifyTyped(el, value) {
  const actual = (el.value || "").trim();
  return actual === String(value).trim();
}

// ---------------------------------------------------------------------------
// Individual action handlers
// ---------------------------------------------------------------------------

async function executeClick(el, id) {
  await highlight(el, "click", 450);
  el.scrollIntoView({ block: "nearest" });
  el.focus();
  el.click();
  await tick(150);
  const still = document.contains(el);
  return { success: true, verified: still, action: "click", target: id };
}

async function executeType(el, id, value) {
  if (!value && value !== "0") {
    return { success: false, verified: false, action: "type", target: id, error: "no value to type" };
  }
  await highlight(el, "type", 400);
  el.scrollIntoView({ block: "nearest" });
  const typed = await typeInto(el, value);
  const verified = typed && verifyTyped(el, value);
  return { success: typed, verified, action: "type", target: id, value };
}

async function executeSelect(el, id) {
  await highlight(el, "select", 450);
  el.scrollIntoView({ block: "nearest" });

  // For <select> elements
  if (el.tagName === "SELECT") {
    // value already set via observer — just trigger events
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await tick(80);
    return { success: true, verified: Boolean(el.value), action: "select", target: id };
  }

  // For radio inputs (AI picks the element_N of the specific radio to select)
  const radioInput = el.type === "radio" ? el :
    el.querySelector("input[type='radio']") ||
    el.closest("label")?.querySelector("input[type='radio']");

  if (radioInput && !radioInput.checked) {
    radioInput.click();
    await tick(100);
  }
  if (!verifyChecked(radioInput || el)) {
    // Try clicking the label
    const label = el.tagName === "LABEL" ? el : el.closest("label") ||
      document.querySelector(`label[for="${CSS.escape(radioInput?.id || "")}"]`);
    if (label) { label.click(); await tick(100); }
  }
  if (!verifyChecked(radioInput || el)) {
    el.click();
    await tick(100);
  }

  const checked = verifyChecked(radioInput || el);
  return { success: checked, verified: checked, action: "select", target: id };
}

async function executeCheck(el, id) {
  if (verifyChecked(el)) {
    return { success: true, verified: true, action: "check", target: id, note: "already checked" };
  }
  await highlight(el, "check", 400);
  el.click();
  await tick(80);
  const checked = verifyChecked(el);
  return { success: checked, verified: checked, action: "check", target: id };
}

async function executeUncheck(el, id) {
  if (!verifyChecked(el)) {
    return { success: true, verified: true, action: "uncheck", target: id, note: "already unchecked" };
  }
  await highlight(el, "uncheck", 400);
  el.click();
  await tick(80);
  const unchecked = !verifyChecked(el);
  return { success: unchecked, verified: unchecked, action: "uncheck", target: id };
}

async function executeUpload(el, id, resumeData) {
  if (!resumeData || !resumeData.b64) {
    return { success: false, verified: false, action: "upload", target: id, error: "no resume data available" };
  }
  await highlight(el, "upload", 400);
  const done = attachFile(el, resumeData);
  return { success: done, verified: done, action: "upload", target: id };
}

async function executeWait(value) {
  const ms = Math.min(10000, Math.max(100, parseInt(value, 10) || 1500));
  await tick(ms);
  return { success: true, verified: true, action: "wait", ms };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Execute one AgentAction returned by the AI Decision Engine.
 *
 * @param {object} action      Validated AgentAction
 * @param {object} [opts]
 * @param {object} [opts.resumeData]  { b64, name, mime } for upload actions
 * @returns {Promise<object>}  Execution result
 */
async function executeAction(action, { resumeData } = {}) {
  const { action: type, target, value, question, reason } = action;

  // ----- Non-DOM actions ---------------------------------------------------

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

  // ----- DOM actions -------------------------------------------------------

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
    case "upload":  return executeUpload(el, target, resumeData);
    default:
      return { success: false, verified: false, action: type, error: `unhandled action type: "${type}"` };
  }
}

globalThis.linkedinExecutor = { executeAction };
