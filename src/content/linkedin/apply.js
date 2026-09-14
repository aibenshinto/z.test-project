// LinkedIn Easy Apply adapter — AI agent-loop shim.
//
// The old approach (hard-coded DOM walking + per-field RESOLVE_ANSWER) has
// been replaced by the Claude computer-use style AI agent loop. The agent:
//
//   1. Calls linkedinObserver.observe() to get a compact UISnapshot
//   2. Sends AI_DECIDE_ACTION to the service worker
//   3. Receives a validated JSON action { click | type | select | … }
//   4. Calls linkedinExecutor.executeAction() which flashes the highlight
//      ring, performs the action, and verifies the result
//   5. Loops until submitted / stopped / waiting-for-user / maxTurns
//
// This file is the entry point called by main.js; it still owns:
//   - External-apply detection (handoff, not automation)
//   - Initial Easy Apply button click to open the dialog
//   - Delegating the multi-step form to linkedinAgentLoop.runAgentLoop()

/* global LINKEDIN_SEL, linkedinCheckAnomaly, linkedinVisible,
          linkedinAgentLoop */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dialog() {
  return [...document.querySelectorAll(LINKEDIN_SEL.form.dialog)]
    .filter(linkedinVisible).at(-1) || null;
}

/**
 * Main apply entry point.
 *
 * @param {object} [_job]  Job metadata (not used by the agent loop; kept for
 *                         API compatibility with main.js callers).
 * @returns {Promise<object>} { submitted, … }
 */
async function apply(_job) {
  // 1. Anomaly check before touching anything
  const anomaly = linkedinCheckAnomaly();
  if (anomaly) return { submitted: false, blocked: true, reason: anomaly };

  // 2. External-apply guard — we do not automate third-party ATS pages
  if (LINKEDIN_SEL.job.externalApply()) {
    return {
      submitted: false,
      external: true,
      reason: "External company application — automatic submission is not supported for this origin.",
    };
  }

  // 3. Open the Easy Apply dialog if it's not already open
  let root = dialog();
  if (!root) {
    const button = LINKEDIN_SEL.job.easyApply();
    if (!button) {
      return { submitted: false, reason: "No verified LinkedIn Easy Apply button found on this page." };
    }
    button.click();
    // Wait up to 5 s for the dialog to appear
    for (let wait = 0; wait < 20 && !root; wait++) {
      await sleep(250);
      root = dialog();
    }
  }
  if (!root) {
    return { submitted: false, reason: "Easy Apply dialog did not open within 5 seconds." };
  }

  // 4. Hand off to the AI agent loop
  return linkedinAgentLoop.runAgentLoop();
}

globalThis.linkedinApply = { apply };
