// Naukri agent loop — thin adapter over the shared core.
//
// The cycle itself is shared. This file supplies the Naukri platform adapter:
// its authoritative submission check (naukriApplicationSubmitted), its anomaly
// rules (CAPTCHA / rate limit / registration redirect), and the incomplete-
// profile halt.
//
// `submitted: true` requires naukriApplicationSubmitted() or an explicit
// confirmation message. The model's "finish" action alone is never proof.

/* global naukriObserver, naukriScrape, naukriApplicationSubmitted,
          naukriProfileIncomplete */

(function () {
  if (globalThis.naukriAgentLoop) return; // idempotent guard

  const loop = () => globalThis.__autoApplyAgentLoopCore;

  /** @type {import("../shared/agent-loop-core.js").PlatformAdapter} */
  const adapter = {
    name: "naukri",
    settleMax: 2000,
    observe: () => naukriObserver.observe(),
    isComplete: () => naukriObserver.isComplete(),
    checkAnomaly: () => {
      // Naukri's own anomaly rules first.
      const anomaly = naukriScrape.checkAnomaly();
      if (anomaly) return anomaly;
      // An incomplete Naukri profile reuses the apply drawer for resume and
      // headline nags. Continuing would answer the wrong form, so halt.
      try {
        if (naukriProfileIncomplete()) {
          return "Naukri profile is incomplete — the site is showing a profile " +
                 "prompt instead of the application. Complete it, then resume.";
        }
      } catch (_) { /* selector helper may be unavailable */ }
      return null;
    },
  };

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxTurns=20]
   * @param {object} [opts.resumeFile]
   * @returns {Promise<object>}
   */
  async function runAgentLoop(opts = {}) {
    // Build a per-run adapter rather than mutating the shared one: on a SPA a
    // second application would otherwise inherit the first run's resume.
    const runAdapter = opts.resumeFile
      ? { ...adapter, resumeData: () => opts.resumeFile }
      : adapter;
    return loop().run(runAdapter, { maxTurns: opts.maxTurns ?? 20 });
  }

  globalThis.naukriAgentLoop = { runAgentLoop, adapter };
}());
