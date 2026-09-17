// Shared action executor with verification and diagnostics (content side).
//
// This replaces the three adapters' "call .click() and report success" path.
// Every interaction now runs:
//
//   resolve current element (re-resolving if the node was replaced)
//     → validate visible / enabled
//     → fingerprint the page
//     → interact (DOM click first, pointer sequence on escalation)
//     → wait for the page to settle
//     → fingerprint again
//     → classify: CONFIRMED / NO_EFFECT / FAILED / STALE
//
// The distinction that matters: ACTION_EXECUTED means JavaScript ran.
// ACTION_CONFIRMED means the website reacted. Only the second is success.
//
// Adapters supply platform hints (extra success indicators, settle time);
// nothing here is platform-specific.

(function () {
  if (globalThis.__autoApplyExecutorCore) return; // idempotent guard

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const obs = () => globalThis.__autoApplyObserverCore;
  const ptr = () => globalThis.__autoApplyPointer;
  const core = () => globalThis.__autoApplyInteractionCore;
  const diag = () => globalThis.__autoApplyDiagnostics;

  /** Fingerprint fields whose change indicates a real UI transition. */
  const STRUCTURAL_CHANGES = ["url", "title", "modal", "applicationState", "controlCount", "fieldCount", "errors"];

  const RESULT = {
    EXECUTED: "ACTION_EXECUTED",
    CONFIRMED: "ACTION_CONFIRMED",
    NO_EFFECT: "ACTION_NO_EFFECT",
    FAILED: "ACTION_FAILED",
    STALE: "ACTION_STALE",
  };

  // -------------------------------------------------------------------------
  // Settle waiting
  // -------------------------------------------------------------------------

  /**
   * Wait for the page to stop changing after an interaction, up to a bound.
   *
   * A fixed sleep is either too short for a slow SPA or wastes time on a fast
   * one. This polls the fingerprint and returns as soon as it changes, so a
   * modal that opens in 200ms does not cost 2000ms.
   *
   * @param {object} before   Fingerprint taken before the interaction
   * @param {object} [opts]
   * @param {number} [opts.min=350]   Always wait at least this long
   * @param {number} [opts.max=2000]  Give up waiting after this long
   */
  async function waitForSettle(before, { min, max = 2000 } = {}) {
    // The floor gives a framework time to start rendering before we look, but
    // it must never exceed the caller's overall budget — otherwise a short
    // settleMax still costs the full default wait.
    if (min == null) min = Math.min(350, Math.round(max / 2));
    const started = Date.now();
    const wasHidden = pageHidden();
    await sleep(min);

    while (Date.now() - started < max) {
      // The page went into the background — typically the click opened a new
      // tab. Nothing here will change, and a hidden page's timers are
      // throttled to about one per second, so stop waiting.
      if (!wasHidden && pageHidden()) return obs().fingerprint();

      const now = obs().fingerprint();
      // Return early only on a structural change — the same bar the outcome
      // classifier uses. Text drifting on its own must not cut the wait short
      // and rob a slow transition of its remaining budget.
      const { changes } = core().diffPageState(before, now);
      if (changes.some((c) => STRUCTURAL_CHANGES.includes(c))) {
        // Let the transition finish rendering before we observe properly.
        await sleep(200);
        return obs().fingerprint();
      }
      await sleep(150);
    }
    return obs().fingerprint();
  }

  function pageHidden() {
    return document.visibilityState === "hidden";
  }

  // -------------------------------------------------------------------------
  // New tabs
  // -------------------------------------------------------------------------

  /**
   * Did this page open a new tab since `since`?
   *
   * A click on a target=_blank link changes nothing on this page, so without
   * asking, it reads as "no effect" and the click is retried — opening the
   * tab again. Only the worker can see other tabs.
   *
   * @returns {Promise<{id, url}|null>}
   */
  async function tabOpenedSince(since, waitMs = 0) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "TAB_OPENED_SINCE", since, waitMs });
      return res?.opened && res.tab?.id ? res.tab : null;
    } catch (_) {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Target resolution with staleness handling
  // -------------------------------------------------------------------------

  /**
   * Resolve a logical element ID to a live, interactable element.
   * @returns {{el, meta, reresolved} | {error, stale}}
   */
  function resolveTarget(id) {
    const resolved = obs().resolveLive(id);
    if (resolved.error) return resolved;

    const { el, meta } = resolved;
    if (!meta.visible) {
      return { error: `element "${id}" is present but not visible`, stale: false };
    }
    if (meta.disabled) {
      return { error: `element "${id}" ("${meta.text || meta.ariaLabel}") is disabled`, stale: false };
    }
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Highlight (reuses the existing shared ring)
  // -------------------------------------------------------------------------

  async function highlight(el, kind, ms = 450) {
    try {
      await globalThis.__autoApplyHighlight?.highlightElement(el, kind, ms);
    } catch (_) { /* non-fatal */ }
  }

  // -------------------------------------------------------------------------
  // Click with escalation (Parts 7, 8, 10, 11, 12)
  // -------------------------------------------------------------------------

  /**
   * Click a logical target and report what the WEBSITE did, not what
   * JavaScript did.
   *
   * Escalation across attempts:
   *   attempt 0 — DOM .click()
   *   attempt 1 — full pointer sequence at the live rect
   *   attempt 2 — re-resolve the target, then pointer sequence
   *
   * @param {string} id      element_N
   * @param {object} [opts]
   * @param {number} [opts.maxRetries]
   * @param {number} [opts.settleMax]  Per-platform settle bound
   * @returns {Promise<object>} result with .result, .diagnostics
   */
  async function click(id, opts = {}) {
    const maxRetries = opts.maxRetries ?? core().MAX_CLICK_RETRIES;
    const settleMax = opts.settleMax ?? 2000;
    const wantDouble = Boolean(opts.double);
    const attempts = [];
    const startedAt = Date.now();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const resolved = resolveTarget(id);

      if (resolved.error) {
        attempts.push({
          attempt,
          method: "resolve",
          result: resolved.stale ? RESULT.STALE : RESULT.FAILED,
          error: resolved.error,
        });
        // A stale target is worth one more pass — resolveLive re-searches the
        // live DOM on every call, so the next attempt may find the new node.
        if (resolved.stale && attempt + 1 < maxRetries) {
          await sleep(300);
          continue;
        }
        return finish(id, RESULT.FAILED, attempts, { error: resolved.error });
      }

      const { el, meta, reresolved } = resolved;
      // A double click has no plain-DOM equivalent worth trying first: it must
      // be a real pointer sequence for the page to see two activations.
      const method = wantDouble ? "double_click" : (attempt === 0 ? "dom_click" : "pointer_click");

      log(`[EXECUTOR] Resolving current target ${id}${reresolved ? " (re-resolved after rerender)" : ""}`);
      log(`[EXECUTOR] Element visible=${meta.visible} enabled=${meta.enabled} text="${meta.text || meta.ariaLabel}"`);
      log(`[EXECUTOR] Attempting ${
        method === "dom_click" ? "DOM click"
        : method === "double_click" ? "pointer double click"
        : "pointer click"}`);

      const before = obs().fingerprint();
      await highlight(el, "click", 350);

      const note = `Clicking "${(meta.text || meta.ariaLabel || "control").slice(0, 60)}"`;
      const exec = method === "double_click" ? await ptr().doubleClick(el, { note })
        : method === "dom_click" ? await ptr().domClick(el, { note })
        : await ptr().pointerClick(el, { note });

      if (!exec.executed) {
        attempts.push({ attempt, method, result: RESULT.FAILED, error: exec.error, rect: meta.rect });
        log(`[EXECUTOR] ${method} could not be dispatched: ${exec.error}`);
        // Pause before retrying so a transient condition (mid-scroll, an
        // animating overlay) has a chance to clear.
        await sleep(250);
        continue;
      }

      const after = await waitForSettle(before, { max: settleMax });
      const targetGone = !el.isConnected;
      const outcome = core().classifyClickOutcome({ executed: true, before, after, targetGone });

      attempts.push({
        attempt,
        method,
        result: outcome.result,
        changes: outcome.changes,
        reason: outcome.reason,
        point: exec.point || null,
        hitTarget: exec.hitTarget || null,
        rect: meta.rect,
        beforeState: summarize(before),
        afterState: summarize(after),
      });

      // Always ask, even when this page reacted: one click can do both. A job
      // board's apply control opens the company's application in a new tab
      // AND sends this tab to its own record of the click — a page with
      // nothing to apply with. Reading that as "the click worked, carry on
      // here" leaves the real application sitting untouched in the other tab.
      //
      // A hidden page means focus moved to the new tab, and a navigation here
      // means the click did something wholesale; the record of the new tab can
      // lag either, so allow it a moment to arrive.
      const hidden = pageHidden();
      const navigated = (outcome.changes || []).includes("url");
      const openedTab = await tabOpenedSince(startedAt, hidden ? 1500 : navigated ? 1000 : 0);
      if (openedTab) {
        const last = attempts[attempts.length - 1];
        last.result = RESULT.CONFIRMED;
        last.changes = [...(last.changes || []), "newTab"];
        last.reason = `the click opened ${openedTab.url || "a page"} in a new tab`;
        log(`[VERIFY] ${last.reason}`);
        return finish(id, RESULT.CONFIRMED, attempts, { meta, before, after, changes: last.changes, openedTab });
      }

      if (outcome.result === core().ACTION_RESULT.CONFIRMED) {
        log(`[VERIFY] ${outcome.reason}`);
        log("[AGENT] Click confirmed");
        return finish(id, RESULT.CONFIRMED, attempts, { meta, before, after, changes: outcome.changes });
      }

      log(`[VERIFY] No state change after ${method}`);
      log(`[EXECUTOR] ${method} had no observable effect`);

      const strategy = core().nextClickStrategy(outcome.result, attempt, maxRetries);
      if (strategy.next === "reassess") break;

      if (strategy.method === "reresolve_then_pointer") {
        // Force the next attempt to re-find the control rather than reusing
        // the node we already failed against: the page may have swapped it
        // for an equivalent one that does respond.
        log("[EXECUTOR] Re-observing target");
        obs().rebindStale(id);
      }
      await sleep(250);
    }

    const last = attempts[attempts.length - 1];
    return finish(id, last?.result === RESULT.FAILED ? RESULT.FAILED : RESULT.NO_EFFECT, attempts, {
      error: last?.error,
    });
  }

  function summarize(fp) {
    if (!fp) return null;
    return {
      url: fp.url,
      modal: fp.modalOpen,
      controls: fp.controlCount,
      fields: fp.fieldCount,
      state: fp.applicationState,
    };
  }

  function finish(id, result, attempts, extra = {}) {
    const meta = extra.meta || obs().getMeta(id) || {};
    const record = {
      action: "click",
      target: id,
      targetText: meta.text || meta.ariaLabel || "",
      method: attempts[attempts.length - 1]?.method || "none",
      timestamp: new Date().toISOString(),
      visible: meta.visible ?? null,
      enabled: meta.enabled ?? null,
      rect: meta.rect || null,
      beforeState: summarize(extra.before),
      afterState: summarize(extra.after),
      result,
      error: extra.error || null,
      retryCount: Math.max(0, attempts.length - 1),
      attempts,
    };

    diag()?.record(record);

    return {
      // Legacy fields — the existing agent loops read these.
      success: result === RESULT.CONFIRMED,
      verified: result === RESULT.CONFIRMED,
      action: "click",
      target: id,
      error: extra.error || (result === RESULT.NO_EFFECT
        ? "the click was dispatched but the website did not react" : null),
      // New fields.
      result,
      changes: extra.changes || [],
      // Set when the click opened a new tab; the caller decides whether to
      // follow it or close it.
      openedTab: extra.openedTab || null,
      diagnostics: record,
    };
  }

  function log(msg) {
    try { console.debug(msg); } catch (_) { /* non-fatal */ }
  }

  // -------------------------------------------------------------------------
  // Typing
  // -------------------------------------------------------------------------

  const DESCRIPTORS = {
    input: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
    textarea: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value"),
  };

  function setNativeValue(el, value) {
    const desc = el.tagName === "TEXTAREA" ? DESCRIPTORS.textarea : DESCRIPTORS.input;
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  /**
   * Type into a field. contenteditable is handled separately because setting
   * `.value` on one is a silent no-op.
   */
  async function type(id, value, opts = {}) {
    const resolved = resolveTarget(id);
    if (resolved.error) {
      return legacyFail("type", id, resolved.error, resolved.stale);
    }
    const { el } = resolved;
    const text = String(value ?? "");
    const tag = el.tagName?.toLowerCase();

    // Models routinely confuse type with select. Calling the input value
    // setter on a foreign element throws "Illegal invocation", which would
    // abort the whole run, so route the obvious case instead of failing.
    if (tag === "select") return select(id, text);

    if (tag !== "input" && tag !== "textarea" && !el.isContentEditable) {
      return {
        success: false, verified: false, action: "type", target: id,
        result: RESULT.FAILED,
        error: `element "${id}" is a <${tag}> and cannot be typed into`,
      };
    }

    await highlight(el, "type", 350);
    await ptr().scrollIntoView(el);

    // Move the visible cursor to the field so the user can follow the fill.
    const fieldRect = el.getBoundingClientRect();
    if (fieldRect.width > 0 && fieldRect.height > 0) {
      const label = obs().describe(el);
      // Cosmetic: a failing overlay must never stop the field being filled.
      try {
        await globalThis.__autoApplyCursor?.moveTo(
          Math.round(fieldRect.x + fieldRect.width / 2),
          Math.round(fieldRect.y + fieldRect.height / 2),
          { note: `Filling "${(label.text || label.ariaLabel || "field").slice(0, 40)}"` },
        );
      } catch (_) { /* cosmetic only */ }
    }

    el.focus?.({ preventScroll: true });

    if (el.isContentEditable) {
      el.textContent = "";
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.select?.();
      setNativeValue(el, text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    await sleep(100);
    if (opts.blur !== false) el.blur?.();
    await sleep(80);

    const actual = el.isContentEditable
      ? String(el.textContent || "").trim()
      : String(el.value || "").trim();
    const ok = actual === text.trim();

    return {
      success: ok,
      verified: ok,
      action: "type",
      target: id,
      value: text,
      result: ok ? RESULT.CONFIRMED : RESULT.NO_EFFECT,
      error: ok ? null : `field still reads "${actual.slice(0, 80)}" after typing`,
    };
  }

  // -------------------------------------------------------------------------
  // Checkbox / radio / select
  // -------------------------------------------------------------------------

  function checkedState(el) {
    if (el.type === "radio" || el.type === "checkbox") return el.checked === true;
    if (el.getAttribute?.("aria-checked")) return el.getAttribute("aria-checked") === "true";
    const input = el.querySelector?.("input[type='radio'], input[type='checkbox']") ||
                  el.closest?.("label")?.querySelector("input[type='radio'], input[type='checkbox']");
    return input ? input.checked === true : false;
  }

  /**
   * Set a radio/checkbox to a desired state, trying the input, then its label,
   * then a pointer sequence — verifying `.checked` after each.
   */
  async function setChecked(id, desired, actionName) {
    const resolved = resolveTarget(id);
    if (resolved.error) return legacyFail(actionName, id, resolved.error, resolved.stale);

    const { el } = resolved;
    const input = (el.type === "radio" || el.type === "checkbox") ? el
      : el.querySelector?.("input[type='radio'], input[type='checkbox']") ||
        el.closest?.("label")?.querySelector("input[type='radio'], input[type='checkbox']") || el;

    if (checkedState(input) === desired) {
      return {
        success: true, verified: true, action: actionName, target: id,
        result: RESULT.CONFIRMED, note: `already ${desired ? "checked" : "unchecked"}`,
      };
    }

    await highlight(el, actionName, 350);
    await ptr().scrollIntoView(el);

    // 1. the input itself
    try { input.click(); } catch (_) { /* fall through */ }
    await sleep(90);

    // 2. its label
    if (checkedState(input) !== desired) {
      const label = input.id
        ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
        : input.closest?.("label");
      if (label) { try { label.click(); } catch (_) { /* fall through */ } await sleep(90); }
    }

    // 3. a real pointer sequence on the visible control
    if (checkedState(input) !== desired) {
      await ptr().pointerClick(el);
      await sleep(120);
    }

    const ok = checkedState(input) === desired;
    return {
      success: ok, verified: ok, action: actionName, target: id,
      result: ok ? RESULT.CONFIRMED : RESULT.NO_EFFECT,
      error: ok ? null : `control did not become ${desired ? "checked" : "unchecked"}`,
    };
  }

  /**
   * Choose an option in a <select>, or select a radio option.
   * For a native select the value is matched against option text or value.
   */
  async function select(id, value) {
    const resolved = resolveTarget(id);
    if (resolved.error) return legacyFail("select", id, resolved.error, resolved.stale);

    const { el } = resolved;
    await highlight(el, "select", 350);
    await ptr().scrollIntoView(el);

    if (el.tagName === "SELECT") {
      const wanted = String(value ?? "").trim().toLowerCase();
      let matched = null;
      for (const opt of el.options) {
        const text = String(opt.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (text === wanted || String(opt.value).toLowerCase() === wanted) { matched = opt; break; }
      }
      if (!matched && wanted) {
        matched = [...el.options].find((o) =>
          String(o.textContent || "").toLowerCase().includes(wanted));
      }
      if (!matched) {
        return {
          success: false, verified: false, action: "select", target: id,
          result: RESULT.FAILED,
          error: `no option matching "${value}" in this dropdown`,
        };
      }
      el.value = matched.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(120);
      const ok = el.value === matched.value;
      return {
        success: ok, verified: ok, action: "select", target: id,
        result: ok ? RESULT.CONFIRMED : RESULT.NO_EFFECT,
        value: matched.textContent?.trim(),
      };
    }

    // A radio group is published to the model as ONE element whose id is its
    // first option, with the rest listed under `options`. Selecting it must
    // honour `value`: checking the first option regardless would answer "Yes"
    // to a question the model answered "No".
    if (el.type === "radio" && el.name && value != null && String(value).trim()) {
      const wanted = String(value).trim().toLowerCase();
      const group = [...document.querySelectorAll(
        `input[type='radio'][name="${CSS.escape(el.name)}"]`,
      )].filter((r) => obs().isVisible(r));

      const labelOf = (radio) => obs().describe(radio).text || radio.value || "";
      let target = group.find((r) => labelOf(r).trim().toLowerCase() === wanted) ||
                   group.find((r) => String(r.value).trim().toLowerCase() === wanted) ||
                   group.find((r) => labelOf(r).toLowerCase().includes(wanted));

      if (!target) {
        return {
          success: false, verified: false, action: "select", target: id,
          result: RESULT.FAILED,
          error: `no option matching "${value}" in this group ` +
                 `(options: ${group.map(labelOf).join(", ")})`,
        };
      }
      if (target !== el) {
        // Register the option actually being chosen so the interaction, the
        // verification and the diagnostics all refer to the same control.
        const optionId = obs().registerElement(target, obs().describe(target));
        return setChecked(optionId, true, "select");
      }
    }

    // A specific radio option, or a custom listbox option.
    return setChecked(id, true, "select");
  }

  // -------------------------------------------------------------------------
  // File upload
  // -------------------------------------------------------------------------

  async function upload(id, resumeData) {
    const resolved = resolveTarget(id);
    if (resolved.error) return legacyFail("upload", id, resolved.error, resolved.stale);
    if (!resumeData?.b64) {
      return {
        success: false, verified: false, action: "upload", target: id,
        result: RESULT.FAILED, error: "no resume data available",
      };
    }

    const el = resolved.el;
    const fileInput = el.type === "file" ? el : el.querySelector?.("input[type='file']");
    if (!fileInput) {
      return {
        success: false, verified: false, action: "upload", target: id,
        result: RESULT.FAILED, error: "target is not a file input",
      };
    }

    try {
      const bytes = Uint8Array.from(atob(resumeData.b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], resumeData.name || "resume.pdf", {
        type: resumeData.mime || "application/pdf",
      }));
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("input", { bubbles: true }));
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(250);
      const ok = fileInput.files.length === 1;
      return {
        success: ok, verified: ok, action: "upload", target: id,
        result: ok ? RESULT.CONFIRMED : RESULT.NO_EFFECT,
      };
    } catch (err) {
      return {
        success: false, verified: false, action: "upload", target: id,
        result: RESULT.FAILED, error: String(err?.message || err),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Navigation / scrolling / keys
  // -------------------------------------------------------------------------

  async function keyPress(key, targetId) {
    let el;
    if (targetId) {
      const resolved = resolveTarget(targetId);
      if (resolved.error) return legacyFail("key_press", targetId, resolved.error, resolved.stale);
      el = resolved.el;
      el.focus?.({ preventScroll: true });
    }
    const before = obs().fingerprint();
    const res = await ptr().keyPress(key, el);
    if (!res.executed) {
      return {
        success: false, verified: false, action: "key_press",
        result: RESULT.FAILED, error: res.error,
      };
    }
    const after = await waitForSettle(before, { min: 250, max: 1500 });
    const { changed, changes } = core().diffPageState(before, after);
    // A key that produced no observable change is NO_EFFECT, like any other
    // action. Reporting success here would also reset the loop's stuck
    // detector, letting a model alternate click/key_press forever.
    return {
      success: changed,
      verified: changed,
      action: "key_press",
      key: res.key,
      result: changed ? RESULT.CONFIRMED : RESULT.NO_EFFECT,
      changes,
      error: changed ? null : `pressing ${res.key} did not change the page`,
    };
  }

  async function scroll(direction, amount) {
    const res = await ptr().scroll(direction, amount);
    return {
      success: true, verified: res.moved, action: "scroll",
      result: res.moved ? RESULT.CONFIRMED : RESULT.NO_EFFECT,
      from: res.from, to: res.to,
    };
  }

  async function scrollTo(id) {
    const resolved = resolveTarget(id);
    if (resolved.error) return legacyFail("scroll_to", id, resolved.error, resolved.stale);
    await ptr().scrollTo(resolved.el);
    return { success: true, verified: true, action: "scroll_to", target: id, result: RESULT.CONFIRMED };
  }

  /**
   * History navigation. Verified by checking the URL actually changed —
   * going back from the first page in a tab does nothing.
   */
  async function historyGo(delta) {
    const before = obs().fingerprint();
    if (delta < 0) history.back(); else history.forward();
    const after = await waitForSettle(before, { min: 500, max: 3000 });
    const changed = before.url !== after.url;
    return {
      success: changed,
      verified: changed,
      action: delta < 0 ? "go_back" : "go_forward",
      result: changed ? RESULT.CONFIRMED : RESULT.NO_EFFECT,
      error: changed ? null : "the URL did not change",
    };
  }

  function legacyFail(action, target, error, stale) {
    return {
      success: false, verified: false, action, target, error,
      result: stale ? RESULT.STALE : RESULT.FAILED,
    };
  }

  globalThis.__autoApplyExecutorCore = {
    click, type, select, setChecked, upload, keyPress, scroll, scrollTo, historyGo,
    resolveTarget, waitForSettle, checkedState, RESULT,
  };
}());
