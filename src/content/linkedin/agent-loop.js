// LinkedIn agent loop — thin adapter over the shared core.
//
// The cycle itself is shared. This file supplies the LinkedIn platform
// adapter: its authoritative completion check, its anomaly rules, and the
// settle timing appropriate to an in-place Easy Apply wizard.
//
// `submitted: true` requires linkedinObserver.isComplete() or an explicit
// confirmation message. The model's "finish" action alone is never proof.

/* global linkedinObserver, linkedinCheckAnomaly */

(function () {
  if (globalThis.linkedinAgentLoop) return; // idempotent guard

  const loop = () => globalThis.__autoApplyAgentLoopCore;

  /** @type {import("../shared/agent-loop-core.js").PlatformAdapter} */
  const adapter = {
    name: "linkedin",
    settleMax: 2000,
    observe: () => linkedinObserver.observe(),
    isComplete: () => linkedinObserver.isComplete(),
    // LinkedIn's own CAPTCHA / checkpoint / auth-wall rules, preserved.
    checkAnomaly: () => linkedinCheckAnomaly(),
  };

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxTurns=25]
   * @returns {Promise<object>}
   */
  async function runAgentLoop(opts = {}) {
    return loop().run(adapter, { maxTurns: opts.maxTurns ?? 25 });
  }

  globalThis.linkedinAgentLoop = { runAgentLoop, adapter };
}());
