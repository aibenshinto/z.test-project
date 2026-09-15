// Visible agent cursor.
//
// An extension cannot move the operating system's real mouse pointer, and no
// browser API exposes one. What a user sees in a tool like Claude in Chrome is
// a drawn indicator that follows the same coordinates the synthetic pointer
// events use. This draws that indicator.
//
// It is purely cosmetic: the actual interaction is the pointer-event sequence
// in pointer-actions.js, which works whether or not this overlay is present.
// Because it is cosmetic, every call is wrapped so a drawing failure can never
// break an action.
//
// The overlay is `pointer-events: none` throughout, so it can never intercept
// a click meant for the page, and it hides itself during hit-testing.

(function () {
  if (globalThis.__autoApplyCursor) return; // idempotent guard

  const ROOT_ID = "__aa_cursor_root__";
  const STYLE_ID = "__aa_cursor_style__";

  let enabled = true;
  let root = null;
  let dot = null;
  let label = null;
  let ripple = null;
  let position = { x: 0, y: 0 };

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ROOT_ID} {
        position: fixed;
        left: 0; top: 0;
        width: 0; height: 0;
        pointer-events: none;
        z-index: 2147483647;
      }
      #${ROOT_ID} .aa-dot {
        position: fixed;
        width: 22px; height: 22px;
        margin-left: -3px; margin-top: -3px;
        pointer-events: none;
        transition: transform 120ms linear;
        will-change: transform;
      }
      #${ROOT_ID} .aa-label {
        position: fixed;
        pointer-events: none;
        transform: translate(18px, 14px);
        background: rgba(17, 24, 39, 0.92);
        color: #fff;
        font: 500 11px/1.4 system-ui, -apple-system, sans-serif;
        padding: 3px 7px;
        border-radius: 5px;
        white-space: nowrap;
        max-width: 280px;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      }
      #${ROOT_ID} .aa-ripple {
        position: fixed;
        width: 14px; height: 14px;
        margin-left: -7px; margin-top: -7px;
        border-radius: 50%;
        pointer-events: none;
        border: 2px solid rgba(90, 150, 255, 0.9);
        opacity: 0;
      }
      @keyframes __aa_click_ripple__ {
        0%   { opacity: 0.9; transform: scale(0.35); }
        100% { opacity: 0;   transform: scale(3.2); }
      }
      #${ROOT_ID} .aa-ripple.aa-fire {
        animation: __aa_click_ripple__ 420ms ease-out forwards;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // A cursor arrow drawn inline, so no asset needs to be loaded.
  const ARROW_SVG =
    '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M4 2 L4 16.5 L8 12.8 L10.6 18.6 L13.3 17.4 L10.7 11.7 L16 11.5 Z" ' +
    'fill="#111827" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  function ensureRoot() {
    if (root && root.isConnected) return root;
    ensureStyle();

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("aria-hidden", "true");

    dot = document.createElement("div");
    dot.className = "aa-dot";
    dot.innerHTML = ARROW_SVG;

    label = document.createElement("div");
    label.className = "aa-label";
    label.hidden = true;

    ripple = document.createElement("div");
    ripple.className = "aa-ripple";

    root.append(ripple, dot, label);
    (document.body || document.documentElement).appendChild(root);
    return root;
  }

  function place(x, y) {
    ensureRoot();
    position = { x, y };
    const t = `translate(${x}px, ${y}px)`;
    dot.style.transform = t;
    label.style.transform = `translate(${x + 18}px, ${y + 14}px)`;
    ripple.style.transform = `translate(${x}px, ${y}px)`;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Glide the cursor to a point over a short duration, so the user can follow
   * where the agent is going rather than seeing it teleport.
   *
   * @param {number} x  Viewport coordinate
   * @param {number} y  Viewport coordinate
   * @param {object} [opts]
   * @param {number} [opts.duration=260]  Total travel time in ms
   * @param {string} [opts.note]          Caption to show beside the cursor
   */
  async function moveTo(x, y, opts = {}) {
    if (!enabled) return;
    try {
      ensureRoot();
      if (opts.note) setNote(opts.note);

      const from = position;
      const duration = Math.max(0, opts.duration ?? 260);
      const steps = Math.max(1, Math.round(duration / 16));

      // On the first move there is no meaningful origin, so just appear.
      if (!from.x && !from.y) { place(x, y); return; }

      for (let i = 1; i <= steps; i++) {
        // Ease-out so the motion reads as deliberate rather than mechanical.
        const t = 1 - Math.pow(1 - i / steps, 3);
        place(from.x + (x - from.x) * t, from.y + (y - from.y) * t);
        await sleep(duration / steps);
      }
      place(x, y);
    } catch (_) { /* cosmetic only */ }
  }

  /** Flash a ripple at the cursor to show a click landing. */
  function flashClick() {
    if (!enabled) return;
    try {
      ensureRoot();
      ripple.classList.remove("aa-fire");
      // Force a reflow so the animation restarts on repeated clicks.
      void ripple.offsetWidth;
      ripple.classList.add("aa-fire");
    } catch (_) { /* cosmetic only */ }
  }

  /** Show what the agent is doing, beside the cursor. */
  function setNote(text) {
    if (!enabled) return;
    try {
      ensureRoot();
      const value = String(text || "").slice(0, 120);
      label.textContent = value;
      label.hidden = !value;
    } catch (_) { /* cosmetic only */ }
  }

  function clearNote() {
    try { if (label) { label.textContent = ""; label.hidden = true; } } catch (_) { /* cosmetic */ }
  }

  /**
   * Hide the overlay while the caller hit-tests the page.
   *
   * The overlay is pointer-events:none so it should never be returned by
   * elementFromPoint, but a page's own overlay logic can still be confused by
   * an unexpected node, and this keeps screenshots of the failure clean.
   */
  function withHidden(fn) {
    if (!root) return fn();
    const prev = root.style.display;
    root.style.display = "none";
    try { return fn(); } finally { root.style.display = prev; }
  }

  function show() { enabled = true; try { ensureRoot(); root.style.display = ""; } catch (_) { /* cosmetic */ } }

  function hide() {
    enabled = false;
    try { if (root) root.style.display = "none"; } catch (_) { /* cosmetic */ }
  }

  function destroy() {
    try { root?.remove(); } catch (_) { /* cosmetic */ }
    root = dot = label = ripple = null;
    position = { x: 0, y: 0 };
  }

  function isEnabled() { return enabled; }
  function setEnabled(on) { on ? show() : hide(); }
  function getPosition() { return { ...position }; }

  globalThis.__autoApplyCursor = {
    moveTo, flashClick, setNote, clearNote, withHidden,
    show, hide, destroy, isEnabled, setEnabled, getPosition,
  };
}());
