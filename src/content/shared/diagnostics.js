// Click diagnostics and debug capture (content-script side).
//
// Part 14/15/24: every interaction produces a structured record so a failure
// can be explained after the fact instead of guessed at. Records live in a
// bounded in-page ring buffer and are forwarded to the service worker, which
// persists them (and, when debugging is enabled, before/after screenshots).
//
// Screenshots and DOM snapshots are captured ONLY for failed interactions and
// ONLY when debug mode is on, so a normal run costs nothing extra.

(function () {
  if (globalThis.__autoApplyDiagnostics) return; // idempotent guard

  const MAX_RECORDS = 50;
  const records = [];

  let debugEnabled = false;
  let sequence = 0;

  /** Ask the worker once whether debug capture is enabled. */
  async function init() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_DEBUG_MODE" });
      debugEnabled = Boolean(res?.debug);
    } catch (_) {
      debugEnabled = false;
    }
    return debugEnabled;
  }

  function isDebugEnabled() { return debugEnabled; }
  function setDebugEnabled(on) { debugEnabled = Boolean(on); }

  /**
   * Record one interaction outcome.
   *
   * Always logs a one-line summary. Failures additionally trigger the
   * debug-capture path when enabled.
   *
   * @param {object} record  See Part 14 for the shape
   */
  function record(rec) {
    const entry = { seq: ++sequence, ...rec };
    records.push(entry);
    if (records.length > MAX_RECORDS) records.shift();

    const ok = entry.result === "ACTION_CONFIRMED";
    const line = `[DIAG] ${entry.action} ${entry.target || ""} ` +
      `"${entry.targetText || ""}" via ${entry.method} → ${entry.result}` +
      (entry.retryCount ? ` (after ${entry.retryCount} retr${entry.retryCount === 1 ? "y" : "ies"})` : "");
    try { ok ? console.debug(line) : console.warn(line); } catch (_) { /* non-fatal */ }

    // Fire-and-forget: the worker persists and, if debugging, screenshots.
    try {
      chrome.runtime.sendMessage({
        type: "CLICK_DIAGNOSTIC",
        record: entry,
        captureScreenshots: debugEnabled && !ok,
        domSnapshot: debugEnabled && !ok ? domSnapshot() : null,
      }).catch(() => {});
    } catch (_) { /* content script may be detached */ }

    return entry;
  }

  /**
   * A compact textual snapshot of the page for a failure report.
   * Deliberately not full HTML: we must not log page contents wholesale.
   */
  function domSnapshot() {
    const obs = globalThis.__autoApplyObserverCore;
    if (!obs) return null;
    try {
      // describeAll, not collectElements: this must not register elements and
      // grow the live registry every time an interaction fails.
      const elements = obs.describeAll(document.body, 60).map((el) => ({
        tag: el.tag, role: el.role, text: (el.text || "").slice(0, 80),
        ariaLabel: el.ariaLabel, visible: el.visible, disabled: el.disabled, rect: el.rect,
      }));
      return {
        url: location.href,
        title: document.title,
        capturedAt: new Date().toISOString(),
        fingerprint: obs.fingerprint(),
        elements,
      };
    } catch (_) {
      return null;
    }
  }

  /** Ask the worker to capture the visible tab right now. */
  async function captureScreenshot(label) {
    if (!debugEnabled) return null;
    try {
      const res = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT", label });
      return res?.ok ? res.dataUrl : null;
    } catch (_) {
      return null;
    }
  }

  function getRecords() { return records.slice(); }
  function clear() { records.length = 0; }

  globalThis.__autoApplyDiagnostics = {
    init, record, getRecords, clear, domSnapshot, captureScreenshot,
    isDebugEnabled, setDebugEnabled,
  };

  // Best-effort startup; failures leave debug simply off.
  init().catch(() => {});
}());
