// LinkedIn executor — thin adapter over the shared core.
//
// LinkedIn's React inputs, artdeco comboboxes and multi-step wizard buttons
// are all driven by the shared executor, which uses React-compatible value
// setters and escalates from a DOM click to a real pointer sequence when the
// page ignores the first attempt.
//
// This file keeps the legacy `linkedinExecutor.executeAction` entry point.

(function () {
  if (globalThis.linkedinExecutor) return; // idempotent guard

  const loop = () => globalThis.__autoApplyAgentLoopCore;

  /**
   * Execute one validated AgentAction against the LinkedIn UI.
   *
   * @param {object} action             Validated AgentAction
   * @param {object} [opts]
   * @param {object} [opts.resumeData]  { b64, name, mime } for uploads
   * @returns {Promise<object>}
   */
  async function executeAction(action, { resumeData } = {}) {
    return loop().dispatch(action, {
      // Easy Apply steps re-render in place and settle quickly.
      settleMax: 2000,
      getResume: async () => resumeData,
    });
  }

  globalThis.linkedinExecutor = { executeAction };
}());
