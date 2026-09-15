// Pointer / mouse interaction (content-script side).
//
// Part 8: DOM `.click()` is tried first because it is cheap and usually works.
// When the page does not react, we escalate to a full pointer sequence that
// looks to the page like a real user pressing the control:
//
//   move → pointerover/enter → pointerdown → mousedown → focus
//        → pointerup → mouseup → click
//
// The coordinate always comes from the element's CURRENT bounding rect, never
// a hardcoded screen position, and is recomputed after scrolling the element
// into view.
//
// SCOPE LIMIT (Part 9): this exists to drive ordinary UI controls reliably on
// pages that ignore a bare `.click()`. It is not, and must not be used as, a
// way to get past a CAPTCHA, bot check or other security challenge. The agent
// loop detects those before acting and hands off to the user.

(function () {
  if (globalThis.__autoApplyPointer) return; // idempotent guard

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------------
  // Scrolling
  // -------------------------------------------------------------------------

  /**
   * Bring an element into view and wait for smooth scrolling to settle, so the
   * rect we measure afterwards is the rect the user sees.
   */
  async function scrollIntoView(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch (_) {
      try { el.scrollIntoView({ block: "center" }); } catch (_) { /* non-fatal */ }
    }
    await sleep(120);
  }

  // -------------------------------------------------------------------------
  // Pointer sequence
  // -------------------------------------------------------------------------

  function pointerInit(x, y, extra = {}) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + (window.screenX || 0),
      screenY: y + (window.screenY || 0),
      button: 0,
      buttons: 0,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      ...extra,
    };
  }

  function firePointer(target, type, x, y, extra) {
    const Ctor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    target.dispatchEvent(new Ctor(type, pointerInit(x, y, extra)));
  }

  function fireMouse(target, type, x, y, extra) {
    target.dispatchEvent(new MouseEvent(type, pointerInit(x, y, extra)));
  }

  /**
   * Dispatch a complete, ordered pointer interaction at the element's centre.
   *
   * Dispatching on the topmost element at that point (rather than blindly on
   * the element itself) matters: many frameworks put the real listener on an
   * overlaying child, and a click aimed at the parent is swallowed.
   *
   * @param {Element} el
   * @returns {Promise<{executed: boolean, point: object|null, error?: string, hitTarget?: string}>}
   */
  async function pointerClick(el) {
    if (!el || !el.isConnected) {
      return { executed: false, point: null, error: "element is not attached to the document" };
    }

    await scrollIntoView(el);

    const core = globalThis.__autoApplyInteractionCore;
    const rect = el.getBoundingClientRect();
    const point = core
      ? core.pointerPointFor(
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          { width: window.innerWidth, height: window.innerHeight },
        )
      : (rect.width > 0 && rect.height > 0
          ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
          : null);

    if (!point) {
      return { executed: false, point: null, error: "element has no usable on-screen position" };
    }

    // Aim at whatever is actually on top at that point, as long as it belongs
    // to our element's subtree (or contains it). Otherwise the element is
    // covered by an unrelated overlay and clicking would hit the wrong thing.
    let target = el;
    let hitTarget = "self";
    const top = document.elementFromPoint(point.x, point.y);
    if (top && top !== el) {
      if (el.contains(top)) {
        target = top;
        hitTarget = "descendant";
      } else if (top.contains(el)) {
        hitTarget = "ancestor";
      } else {
        hitTarget = "obscured";
      }
    }

    const { x, y } = point;
    try {
      firePointer(target, "pointerover", x, y);
      firePointer(target, "pointerenter", x, y);
      fireMouse(target, "mouseover", x, y);
      fireMouse(target, "mousemove", x, y);
      firePointer(target, "pointerdown", x, y, { buttons: 1 });
      fireMouse(target, "mousedown", x, y, { buttons: 1 });

      try { (el.focus ? el : target).focus?.({ preventScroll: true }); } catch (_) { /* non-fatal */ }

      firePointer(target, "pointerup", x, y);
      fireMouse(target, "mouseup", x, y);
      fireMouse(target, "click", x, y, { detail: 1 });
    } catch (err) {
      return { executed: false, point, hitTarget, error: String(err?.message || err) };
    }

    return { executed: true, point, hitTarget };
  }

  /**
   * A plain DOM click — the cheap first attempt.
   * @param {Element} el
   */
  async function domClick(el) {
    if (!el || !el.isConnected) {
      return { executed: false, error: "element is not attached to the document" };
    }
    await scrollIntoView(el);
    try {
      el.focus?.({ preventScroll: true });
      el.click();
      return { executed: true };
    } catch (err) {
      return { executed: false, error: String(err?.message || err) };
    }
  }

  /** Two pointer clicks in quick succession, plus the dblclick event. */
  async function doubleClick(el) {
    const first = await pointerClick(el);
    if (!first.executed) return first;
    await sleep(60);
    const second = await pointerClick(el);
    if (second.executed && second.point) {
      fireMouse(el, "dblclick", second.point.x, second.point.y, { detail: 2 });
    }
    return second;
  }

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  const KEY_MAP = {
    ENTER: { key: "Enter", code: "Enter", keyCode: 13 },
    TAB: { key: "Tab", code: "Tab", keyCode: 9 },
    ESCAPE: { key: "Escape", code: "Escape", keyCode: 27 },
    ESC: { key: "Escape", code: "Escape", keyCode: 27 },
    SPACE: { key: " ", code: "Space", keyCode: 32 },
    BACKSPACE: { key: "Backspace", code: "Backspace", keyCode: 8 },
    DELETE: { key: "Delete", code: "Delete", keyCode: 46 },
    ARROWUP: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ARROWDOWN: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ARROWLEFT: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ARROWRIGHT: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    HOME: { key: "Home", code: "Home", keyCode: 36 },
    END: { key: "End", code: "End", keyCode: 35 },
    PAGEUP: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PAGEDOWN: { key: "PageDown", code: "PageDown", keyCode: 34 },
  };

  /**
   * Press a named key on the focused element (or a given target).
   * Only keys in KEY_MAP are allowed — the model cannot synthesise arbitrary
   * input sequences.
   */
  async function keyPress(keyName, target) {
    const spec = KEY_MAP[String(keyName || "").toUpperCase().trim()];
    if (!spec) return { executed: false, error: `unsupported key: "${keyName}"` };

    const el = target || document.activeElement || document.body;
    const init = { ...spec, bubbles: true, cancelable: true, composed: true, view: window };

    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));

    // Enter on a form control should submit the way a real Enter would.
    if (spec.key === "Enter" && el.form && typeof el.form.requestSubmit === "function") {
      try { el.form.requestSubmit(); } catch (_) { /* non-fatal */ }
    }

    el.dispatchEvent(new KeyboardEvent("keyup", init));
    await sleep(60);
    return { executed: true, key: spec.key };
  }

  // -------------------------------------------------------------------------
  // Scrolling actions
  // -------------------------------------------------------------------------

  async function scroll(direction = "down", amount = 600) {
    const px = Math.min(5000, Math.max(50, Number(amount) || 600));
    const delta = direction === "up" ? -px : px;
    const before = window.scrollY;

    if (direction === "left" || direction === "right") {
      window.scrollBy({ left: direction === "left" ? -px : px, behavior: "instant" });
    } else {
      window.scrollBy({ top: delta, behavior: "instant" });
    }
    await sleep(200);
    return { executed: true, from: before, to: window.scrollY, moved: window.scrollY !== before };
  }

  async function scrollTo(el) {
    if (!el || !el.isConnected) {
      return { executed: false, error: "element is not attached to the document" };
    }
    await scrollIntoView(el);
    return { executed: true };
  }

  globalThis.__autoApplyPointer = {
    domClick, pointerClick, doubleClick, keyPress, scroll, scrollTo, scrollIntoView,
    supportedKeys: Object.keys(KEY_MAP),
  };
}());
