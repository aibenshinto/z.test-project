// Naukri executor — thin adapter over the shared core.
//
// Radio selection was previously the most fragile action here: the shared
// executor keeps the same escalation (click the input, then its label, then a
// real pointer sequence) and still verifies `.checked === true` before
// reporting success.
//
// Naukri's `.textArea` is contenteditable, where setting `.value` is a silent
// no-op. The shared executor's `type` handles contenteditable explicitly.

(function () {
  if (globalThis.naukriExecutor) return; // idempotent guard

  const loop = () => globalThis.__autoApplyAgentLoopCore;

  /**
   * Execute one validated AgentAction against the Naukri UI.
   *
   * @param {object} action                Validated AgentAction
   * @param {object} [opts]
   * @param {object} [opts.resumeFile]     Resume payload for upload actions
   * @param {object} [opts.resumeData]     Alias accepted for consistency
   * @returns {Promise<object>}
   */
  async function executeAction(action, { resumeFile, resumeData } = {}) {
    return loop().dispatch(action, {
      settleMax: 2000,
      getResume: async () => resumeData || resumeFile,
    });
  }

  globalThis.naukriExecutor = { executeAction };
}());
