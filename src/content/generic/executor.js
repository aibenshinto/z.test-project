// Generic (external ATS) executor — thin adapter over the shared core.
//
// The action vocabulary, verification and DOM→pointer escalation all live in
// src/content/shared/executor-core.js. This file maps a validated AgentAction
// onto those primitives and keeps the legacy `executeAction` entry point that
// the agent loop and any older callers use.

(function () {
  if (globalThis.genericExecutor) return; // idempotent guard

  const loop = () => globalThis.__autoApplyAgentLoopCore;

  /**
   * Execute one validated AgentAction.
   *
   * @param {object} action                 Validated AgentAction
   * @param {object} [opts]
   * @param {object} [opts.resumeData]      { b64, name, mime } for uploads
   * @returns {Promise<object>} Result carrying `.result` (ACTION_CONFIRMED /
   *   ACTION_NO_EFFECT / ACTION_FAILED / ACTION_STALE) plus the legacy
   *   `.success` / `.verified` fields.
   */
  async function executeAction(action, { resumeData } = {}) {
    return loop().dispatch(action, {
      settleMax: 2500, // external ATS pages are often slower than a SPA modal
      getResume: async () => resumeData,
    });
  }

  globalThis.genericExecutor = { executeAction };
}());
