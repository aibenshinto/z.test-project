// Naukri AI Agent Loop.
//
// Orchestrates the observe → decide → execute → verify cycle for Naukri's
// radio/form questionnaire panels (NOT the chatbot drawer — that remains
// the existing answerOne() path in apply.js).
//
// Flow per turn:
//   1. Anomaly check (CAPTCHA / login redirect / rate limit)
//   2. Submission check (early exit if already applied)
//   3. observe() → UISnapshot
//   4. sendMessage(AI_DECIDE_ACTION) → AgentAction
//   5. executeAction(action)
//   6. Verify result
//   7. If action failed: one controlled retry, then report failure
//   8. If action succeeded: loop back to step 1
//
// Termination:
//   - action "finish"     → verify naukriApplicationSubmitted() then return
//   - action "stop"       → return { stopped: true, reason }
//   - action "ask_user"   → return { waitingForUser: true, question }
//   - maxTurns exceeded   → return (submitted may still be false)
//   - Anomaly detected    → return { stopped: true, reason: anomaly }
//
// CRITICAL: submitted: true is set ONLY after naukriApplicationSubmitted()
// returns true. The AI action "finish" alone is NOT proof of submission.

/* global naukriObserver, naukriExecutor, naukriApplicationSubmitted,
          naukriScrape */


/**
 * Run the AI agent loop for Naukri's interactive questionnaire.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxTurns=20]        Hard cap on AI decision turns.
 * @param {number} [opts.retryLimit=1]       Max retries on a failed action.
 * @param {File}   [opts.resumeFile]         Resume file for upload actions.
 * @returns {Promise<object>} Result object compatible with the existing
 *   apply.js return contract: { submitted, answered, waitingForUser?,
 *   stopped?, question?, reason?, turns }
 */
async function runAgentLoop({ maxTurns = 20, retryLimit = 1, resumeFile } = {}) {
  const answered = [];
  let turns = 0;

  while (turns < maxTurns) {
    turns++;

    // 1. Anomaly check — always before any DOM interaction
    const anomaly = naukriScrape.checkAnomaly();
    if (anomaly) {
      return {
        submitted: false,
        answered,
        stopped: true,
        blocked: anomaly.includes("CAPTCHA") || anomaly.includes("rate"),
        reason: anomaly,
        turns,
      };
    }

    // 2. Submission check — authoritative source of truth
    if (naukriApplicationSubmitted()) {
      return { submitted: true, answered, turns };
    }

    // 3. Observe current UI
    let snapshot;
    try {
      snapshot = naukriObserver.observe();
    } catch (err) {
      return {
        submitted: false, answered,
        reason: "observer error: " + String(err && err.message ? err.message : err),
        turns,
      };
    }

    // Loading — let the page settle
    if (snapshot.loading) {
      await sleep(1500);
      continue;
    }

    // No interactive controls visible — wait briefly and retry
    if (!snapshot.controls.length && !snapshot.questions.length) {
      await sleep(800);
      continue;
    }

    // 4. Ask the AI what to do
    let action;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "AI_DECIDE_ACTION",
        snapshot,
      });
      if (!res || !res.ok) {
        return {
          submitted: false, answered,
          reason: "AI_DECIDE_ACTION failed: " + (res && res.error || "no response"),
          turns,
        };
      }
      action = res.action;
    } catch (err) {
      return {
        submitted: false, answered,
        reason: "AI message error: " + String(err && err.message ? err.message : err),
        turns,
      };
    }

    // 5. Execute the action with one retry on failure
    let result = await naukriExecutor.executeAction(action, { resumeFile });

    if (!result.success && retryLimit > 0) {
      await sleep(400);
      result = await naukriExecutor.executeAction(action, { resumeFile });
    }

    // Record this turn
    answered.push({
      turn: turns,
      action: action.action,
      target: action.target || null,
      value: action.value || null,
      reason: action.reason || null,
      confidence: action.confidence || null,
      result: {
        success: result.success,
        verified: result.verified,
        error: result.error || null,
      },
    });

    // 6. Handle terminal action results

    if (result.action === "stop" || result.stopped) {
      return {
        submitted: false, answered,
        stopped: true,
        blocked: Boolean(result.blocked),
        reason: result.reason || action.reason || "agent stopped",
        turns,
      };
    }

    if (result.action === "ask_user" || result.waitingForUser) {
      return {
        submitted: false, answered,
        waitingForUser: true,
        question: result.question || action.question || "Additional information required",
        turns,
      };
    }

    if (result.action === "finish" || result.finish) {
      // Verify independently — never trust the AI's claim alone
      await sleep(1000);
      const confirmed = naukriApplicationSubmitted();
      return {
        submitted: confirmed, answered,
        reason: confirmed
          ? "confirmed by apply button state"
          : "AI requested finish but submission could not be confirmed",
        turns,
      };
    }

    // 7. If the action failed and we've already retried, report failure but
    //    do not halt the whole loop — the AI may recover on the next turn.
    if (!result.success) {
      // Surface the failure in the answered log but continue the loop.
      // After 3 consecutive failures on the same action type, stop to avoid
      // an infinite retry loop.
      const recentFails = answered.slice(-3).filter(
        (a) => !a.result.success && a.action === action.action,
      );
      if (recentFails.length >= 3) {
        return {
          submitted: false, answered,
          reason: `action "${action.action}" on "${action.target}" failed 3 times in a row — halting loop`,
          turns,
        };
      }
    }

    // 8. Brief pause between turns (human-like pacing)
    await sleep(350);
  }

  // maxTurns reached
  const finalSubmitted = naukriApplicationSubmitted();
  return {
    submitted: finalSubmitted, answered,
    reason: finalSubmitted
      ? "confirmed by apply button state"
      : `agent loop reached maxTurns (${maxTurns}) without confirmation`,
    turns,
  };
}

globalThis.naukriAgentLoop = { runAgentLoop };
