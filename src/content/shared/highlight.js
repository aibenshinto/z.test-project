// Shared visual highlight ring — injected by platform executors.
//
// Before each AI-driven action, briefly flash a colour-coded outline around the
// target element so the user can watch the agent navigate in real time.
//
// Colour key:
//   blue   — click / select / check / uncheck
//   green  — type / upload
//   amber  — wait
//
// The ring is removed before the action fires, so it never interferes with
// React's synthetic-event listeners or DOM state.

(function () {
  if (globalThis.__autoApplyHighlight) return; // idempotent guard

  const RING_ID = "__aa_highlight_ring__";

  const COLORS = {
    click:   "rgba(90, 150, 255, 0.9)",
    select:  "rgba(90, 150, 255, 0.9)",
    check:   "rgba(90, 150, 255, 0.9)",
    uncheck: "rgba(90, 150, 255, 0.9)",
    type:    "rgba(52, 211, 153, 0.9)",
    upload:  "rgba(52, 211, 153, 0.9)",
    wait:    "rgba(251, 191, 36, 0.9)",
    default: "rgba(180, 180, 180, 0.7)",
  };

  // ---------------------------------------------------------------------------
  // Style injection (once per page)
  // ---------------------------------------------------------------------------

  function ensureStyle() {
    if (document.getElementById("__aa_highlight_style__")) return;
    const style = document.createElement("style");
    style.id = "__aa_highlight_style__";
    style.textContent = `
      @keyframes __aa_pulse__ {
        0%   { opacity: 0; transform: scale(0.96); }
        30%  { opacity: 1; transform: scale(1.01); }
        100% { opacity: 0.6; transform: scale(1); }
      }
      #${RING_ID} {
        position: fixed;
        pointer-events: none;
        z-index: 2147483647;
        border-radius: 5px;
        border: 2.5px solid var(--aa-ring-color, rgba(90,150,255,0.9));
        box-shadow: 0 0 0 3px var(--aa-ring-glow, rgba(90,150,255,0.25));
        transition: border-color 150ms, box-shadow 150ms;
        animation: __aa_pulse__ 0.35s ease-out forwards;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Ring element
  // ---------------------------------------------------------------------------

  function getRing() {
    let ring = document.getElementById(RING_ID);
    if (!ring) {
      ring = document.createElement("div");
      ring.id = RING_ID;
      (document.body || document.documentElement).appendChild(ring);
    }
    return ring;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Flash a coloured ring around `el` for `durationMs` milliseconds, then
   * remove it. Returns a Promise that resolves when the ring is gone.
   *
   * @param {Element} el
   * @param {string}  actionType  e.g. "click" | "type" | "select"
   * @param {number}  [durationMs=500]
   */
  function highlightElement(el, actionType = "default", durationMs = 500) {
    if (!el) return Promise.resolve();

    return new Promise((resolve) => {
      try {
        ensureStyle();
        const ring = getRing();
        const color = COLORS[actionType] || COLORS.default;
        const glow  = color.replace("0.9)", "0.25)");

        const r = el.getBoundingClientRect();
        const PAD = 4;
        ring.style.cssText = [
          `--aa-ring-color: ${color}`,
          `--aa-ring-glow: ${glow}`,
          `left:   ${r.left   - PAD + window.scrollX}px`,
          `top:    ${r.top    - PAD + window.scrollY}px`,
          `width:  ${r.width  + PAD * 2}px`,
          `height: ${r.height + PAD * 2}px`,
          "display: block",
        ].join(";");

        // Use position: fixed (viewport coords) so scrollX/Y don't matter.
        ring.style.left   = `${r.left   - PAD}px`;
        ring.style.top    = `${r.top    - PAD}px`;
        ring.style.width  = `${r.width  + PAD * 2}px`;
        ring.style.height = `${r.height + PAD * 2}px`;

        setTimeout(() => {
          try { ring.style.display = "none"; } catch (_) { /* detached */ }
          resolve();
        }, durationMs);
      } catch (_) {
        resolve();
      }
    });
  }

  /** Remove the ring immediately (called after navigation / page change). */
  function clearHighlight() {
    const ring = document.getElementById(RING_ID);
    if (ring) ring.style.display = "none";
  }

  globalThis.__autoApplyHighlight = { highlightElement, clearHighlight };
}());
