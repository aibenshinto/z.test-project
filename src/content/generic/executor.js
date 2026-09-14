// Generic (External ATS) Browser Action Executor + Verification Engine.
//
// Controlled executor that takes a validated AgentAction from the AI Decision
// Engine, resolves element_N IDs from the genericObserver registry, performs
// the action with React-compatible events, shows the highlight ring, and
// verifies the result before reporting success.
//
// Works on any website — no platform-specific assumptions.

(function () {
  if (globalThis.genericExecutor) return; // idempotent guard

  const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // React-compatible typing
  // ---------------------------------------------------------------------------

  const ReactDescriptor = {
    input:    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,    "value"),
    textarea: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"),
  };

  function setNativeValue(el, value) {
    const desc = el.tagName === "TEXTAREA" ? ReactDescriptor.textarea : ReactDescriptor.input;
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  async function typeInto(el, value) {
    el.scrollIntoView({ block: "nearest" });
    el.focus();
    el.select?.();
    setNativeValue(el, value);
    el.dispatchEvent(new InputEvent("input",  { bubbles: true, data: String(value), inputType: "insertText" }));
    el.dispatchEvent(new Event("change",  { bubbles: true }));
    el.blur();
    await tick(100);
    return String(el.value || "").trim() === String(value).trim();
  }

  function attachFile(fileInput, { b64, name, mime }) {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt    = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: mime || "application/pdf" }));
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      return fileInput.files.length === 1;
    } catch (_) { return false; }
  }

  // ---------------------------------------------------------------------------
  // Highlight helper
  // ---------------------------------------------------------------------------

  async function highlight(el, actionType, ms = 500) {
    try {
      if (globalThis.__autoApplyHighlight) {
        await globalThis.__autoApplyHighlight.highlightElement(el, actionType, ms);
      }
    } catch (_) { /* non-fatal */ }
  }

  // ---------------------------------------------------------------------------
  // Element resolution
  // ---------------------------------------------------------------------------

  function resolveTarget(id) {
    if (!id) return { error: "no target element ID provided" };
    if (!/^element_\d+$/.test(id)) return { error: `invalid element ID format: "${id}"` };
    const el = globalThis.genericObserver.getElement(id);
    if (!el) return { error: `element "${id}" not found — snapshot may be stale` };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { error: `element "${id}" is not visible` };
    return { el };
  }

  // ---------------------------------------------------------------------------
  // Verification helpers
  // ---------------------------------------------------------------------------

  function verifyChecked(el) {
    if (el.type === "radio" || el.type === "checkbox") return el.checked;
    const input = el.querySelector("input[type='radio'],input[type='checkbox']") ||
                  el.closest("label")?.querySelector("input[type='radio'],input[type='checkbox']");
    return input ? input.checked : false;
  }

  function verifyTyped(el, value) {
    return (el.value || "").trim() === String(value).trim();
  }

  // ---------------------------------------------------------------------------
  // Action handlers
  // ---------------------------------------------------------------------------

  async function executeClick(el, id) {
    await highlight(el, "click", 450);
    el.scrollIntoView({ block: "nearest" });
    el.focus();
    el.click();
    await tick(200);
    return { success: true, verified: document.contains(el), action: "click", target: id };
  }

  async function executeType(el, id, value) {
    if (!value && value !== "0") {
      return { success: false, verified: false, action: "type", target: id, error: "no value to type" };
    }
    await highlight(el, "type", 400);
    const typed = await typeInto(el, value);
    return { success: typed, verified: typed && verifyTyped(el, value), action: "type", target: id, value };
  }

  async function executeSelect(el, id) {
    await highlight(el, "select", 450);
    el.scrollIntoView({ block: "nearest" });

    if (el.tagName === "SELECT") {
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await tick(80);
      return { success: true, verified: Boolean(el.value), action: "select", target: id };
    }

    // Radio input
    const radioInput = el.type === "radio" ? el : el.querySelector("input[type='radio']");
    if (radioInput && !radioInput.checked) { radioInput.click(); await tick(100); }

    if (!verifyChecked(radioInput || el)) {
      const lbl = el.closest("label") ||
        (radioInput?.id ? document.querySelector(`label[for="${CSS.escape(radioInput.id)}"]`) : null);
      if (lbl) { lbl.click(); await tick(100); }
    }
    if (!verifyChecked(radioInput || el)) { el.click(); await tick(100); }

    const checked = verifyChecked(radioInput || el);
    return { success: checked, verified: checked, action: "select", target: id };
  }

  async function executeCheck(el, id) {
    if (verifyChecked(el)) return { success: true, verified: true, action: "check", target: id, note: "already checked" };
    await highlight(el, "check", 400);
    el.click(); await tick(80);
    const checked = verifyChecked(el);
    return { success: checked, verified: checked, action: "check", target: id };
  }

  async function executeUncheck(el, id) {
    if (!verifyChecked(el)) return { success: true, verified: true, action: "uncheck", target: id, note: "already unchecked" };
    await highlight(el, "uncheck", 400);
    el.click(); await tick(80);
    const unchecked = !verifyChecked(el);
    return { success: unchecked, verified: unchecked, action: "uncheck", target: id };
  }

  async function executeUpload(el, id, resumeData) {
    if (!resumeData?.b64) {
      return { success: false, verified: false, action: "upload", target: id, error: "no resume data available" };
    }
    await highlight(el, "upload", 400);
    const done = attachFile(el, resumeData);
    return { success: done, verified: done, action: "upload", target: id };
  }

  async function executeWait(value) {
    const ms = Math.min(15000, Math.max(100, parseInt(value, 10) || 1500));
    await tick(ms);
    return { success: true, verified: true, action: "wait", ms };
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  async function executeAction(action, { resumeData } = {}) {
    const { action: type, target, value, question, reason } = action;

    if (type === "wait")     return executeWait(value);
    if (type === "finish")   return { success: true,  verified: true,  action: "finish",   finish: true };
    if (type === "stop")     return { success: false, verified: true,  action: "stop",     stopped: true, reason: reason || "AI requested stop" };
    if (type === "ask_user") return { success: false, verified: true,  action: "ask_user", waitingForUser: true, question: question || "Additional information needed" };

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
        return { success: false, verified: false, action: type, error: `unhandled action: "${type}"` };
    }
  }

  globalThis.genericExecutor = { executeAction };
}());
