// The agent loop's adapter — thin wrapper over the shared core.
//
// The observe → decide → execute → wait → verify → reassess cycle lives in
// src/content/shared/agent-loop-core.js. This file supplies the platform
// adapter for any page the agent lands on: a job board, a company careers
// page, or a third-party ATS.
//
// Lifecycle:
//   the takeover's FILL_APPLICATION runs this loop; it answers no messages of
//   its own
//
// `submitted: true` requires an explicit submission confirmation on the page.
// The model saying "finish" is never sufficient.

(function () {
  if (globalThis.genericAgentLoop) return; // idempotent guard

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

  globalThis.genericAgentLoop = { adapter };
}());
