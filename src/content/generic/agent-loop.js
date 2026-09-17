// The agent loop's adapter — thin wrapper over the shared core.
//
// The observe → decide → execute → wait → verify → reassess cycle lives in
// src/content/shared/agent-loop-core.js. This file supplies the platform
// adapter for any page the agent lands on: a job board, a company careers
// page, or a third-party ATS.
//
// Lifecycle:
//   the takeover drives this loop directly; it answers no messages of its own
//
// `submitted: true` requires an explicit submission confirmation on the page.
// The model saying "finish" is never sufficient.

(function () {
  if (globalThis.genericAgentLoop) return; // idempotent guard

  const loop = () => globalThis.__autoApplyAgentLoopCore;
  const logic = () => globalThis.__autoApplyInteractionCore;
  const obs = () => globalThis.__autoApplyObserverCore;

  /** @type {import("../shared/agent-loop-core.js").PlatformAdapter} */
  const adapter = {
    name: "generic",
    // External ATS pages do full navigations rather than in-place updates, so
    // allow longer for a transition to become observable.
    settleMax: 2500,
    observe: () => globalThis.genericObserver.observe(),
    isComplete: () => globalThis.genericObserver.isComplete(),
    // No platform-specific anomaly rules here: the shared security gate's
    // generic CAPTCHA / challenge / login detection covers arbitrary sites.
    checkAnomaly: () => null,
  };

  /**
   * Run the agent loop against the current company career site.
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  async function runAgentLoop(opts = {}) {
    // If the page is a job posting rather than the form itself, open the
    // application first — verifying that the site actually reacted.
    const snapshot = adapter.observe();
    if (snapshot.page.applicationState === "ready") {
      const opened = await loop().openApplication({
        snapshot,
        opened: () => Boolean(globalThis.genericObserver.findApplicationRoot()),
        settleMax: adapter.settleMax,
      });
      if (!opened.opened) {
        return {
          submitted: false,
          applicationStatus: logic().APPLICATION_STATUS.NOT_SUBMITTED,
          answered: [],
          turns: 0,
          waitingForUser: true,
          question: opened.reason +
            " Please start the application on this page, then continue.",
          reason: opened.reason,
        };
      }
    }

    return loop().run(adapter, { maxTurns: opts.maxTurns ?? 40 });
  }

  globalThis.genericAgentLoop = { runAgentLoop, adapter };
}());
