// LinkedIn Easy Apply adapter — entry point.
//
// Owns the steps that happen before the agent loop takes over:
//   - anomaly / security check
//   - external-apply detection (handoff, not automation)
//   - opening the Easy Apply dialog, VERIFYING that it actually opened
//   - delegating the multi-step form to linkedinAgentLoop
//
// The dialog is opened through the shared openApplication helper rather than a
// bare `button.click()`. That matters: LinkedIn is a React SPA, and a
// programmatic click on the Easy Apply button is sometimes accepted by the DOM
// and ignored by the application. The helper verifies the dialog appeared and
// escalates to a real pointer sequence when it did not.

/* global LINKEDIN_SEL, linkedinCheckAnomaly, linkedinObserver, linkedinAgentLoop */

(function () {
  if (globalThis.linkedinApply) return; // idempotent guard

  const loop = () => globalThis.__autoApplyAgentLoopCore;
  const logic = () => globalThis.__autoApplyInteractionCore;

  /**
   * Main apply entry point.
   *
   * @param {object} [_job]  Job metadata, kept for main.js API compatibility.
   * @returns {Promise<object>} { submitted, applicationStatus, ... }
   */
  async function apply(_job) {
    // 1. Never act past a security challenge.
    const anomaly = linkedinCheckAnomaly();
    if (anomaly) return { submitted: false, blocked: true, stopped: true, reason: anomaly };

    // 2. External company application — hand off rather than guess.
    if (LINKEDIN_SEL.job.externalApply()) {
      return {
        submitted: false,
        applicationStatus: logic().APPLICATION_STATUS.NOT_SUBMITTED,
        external: true,
        reason: "External company application — handing off to the generic browser adapter.",
      };
    }

    // 3. Open the Easy Apply dialog, if it is not already open.
    if (!linkedinObserver.dialogRoot()) {
      const snapshot = linkedinObserver.observe();
      const opened = await loop().openApplication({
        // LinkedIn's own Easy Apply locator is tried first as a hint; the
        // observed apply-intent candidates are the fallback if it misses.
        hint: () => LINKEDIN_SEL.job.easyApply(),
        snapshot,
        opened: () => Boolean(linkedinObserver.dialogRoot()),
        settleMax: 3000,
      });

      if (!opened.opened) {
        return {
          submitted: false,
          applicationStatus: logic().APPLICATION_STATUS.NOT_SUBMITTED,
          reason: opened.reason || "The Easy Apply dialog did not open.",
          tried: opened.tried || [],
        };
      }
    }

    // 4. Hand the multi-step form to the agent loop.
    return linkedinAgentLoop.runAgentLoop();
  }

  globalThis.linkedinApply = { apply };
}());
