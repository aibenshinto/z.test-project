// LinkedIn AI Agent Loop.
//
// Orchestrates the observe → decide → execute → verify cycle for LinkedIn's
// Easy Apply multi-step wizard. Replaces the old hard-coded DOM-walking
// approach in apply.js with the same Claude computer-use style agent loop
// already used by the Naukri adapter.
//
// Flow per turn:
//   1. Anomaly check (CAPTCHA / login / premium gate / security checkpoint)
//   2. Completion check (early exit if submitted)
//   3. observe() → UISnapshot  (compact, no raw HTML)
//   4. sendMessage(AI_DECIDE_ACTION) → AgentAction
//   5. executeAction(action)
//   6. Verify result
//   7. If action failed: one controlled retry, then surface failure to caller
//   8. If action succeeded: loop back to step 1
//
// Termination:
//   - action "finish"   → verify linkedinIsComplete() then return
//   - action "stop"     → return { stopped: true, reason }
//   - action "ask_user" → return { waitingForUser: true, question }
//   - maxTurns exceeded → return (submitted may still be false)
//   - Anomaly detected  → return { stopped: true, reason: anomaly }
//
// CRITICAL: submitted: true is set ONLY after linkedinIsComplete() returns
// true (LinkedIn's own completion indicator). The AI action "finish" alone
// is NOT proof of submission.

/* global linkedinObserver, linkedinExecutor, linkedinCheckAnomaly, LINKEDIN_SEL */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Completion detection
// ---------------------------------------------------------------------------

function linkedinIsComplete() {
  const completionEls = document.querySelectorAll(LINKEDIN_SEL.form.completion);
  return [...completionEls].some((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    return /application (?:was )?(?:submitted|sent)|application complete/i.test(text);
  });
}

// ---------------------------------------------------------------------------
// Resume data fetcher
// ---------------------------------------------------------------------------

async function fetchResumeData() {
  try {
    const ctx = await chrome.runtime.sendMessage({ type: "GET_APPLY_CONTEXT" });
    return ctx?.resume || null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

/**
 * Run the AI agent loop for LinkedIn Easy Apply.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxTurns=25]    Hard cap on AI decision turns.
 * @param {number} [opts.retryLimit=1]   Max retries on a failed action.
 * @returns {Promise<object>} Result: { submitted, answered, waitingForUser?,
 *   stopped?, question?, reason?, turns }
 */
async function runAgentLoop({ maxTurns = 25, retryLimit = 1 } = {}) {
  const answered = [];
  let turns = 0;
  let resumeData = null; // lazy-fetched on first upload action

  while (turns < maxTurns) {
    turns++;

    // 1. Anomaly check — always first
    const anomaly = linkedinCheckAnomaly();
    if (anomaly) {
      return {
        submitted: false,
        answered,
        stopped: true,
        blocked: anomaly.includes("CAPTCHA") || anomaly.includes("checkpoint"),
        reason: anomaly,
        turns,
      };
    }

    // 2. Completion check
    if (linkedinIsComplete()) {
      return { submitted: true, answered, turns };
    }

    // 3. Observe current UI
    let snapshot;
    try {
      snapshot = linkedinObserver.observe();
    } catch (err) {
      return {
        submitted: false, answered,
        reason: "observer error: " + String(err?.message ?? err),
        turns,
      };
    }

    // Loading — wait for the page to settle
    if (snapshot.loading) {
      await sleep(1200);
      continue;
    }

    // Application state: external apply — surface as a clean handoff
    if (snapshot.page?.applicationState === "external") {
      return {
        submitted: false, answered,
        external: true,
        reason: "External company application — automatic submission not supported for this origin.",
        turns,
      };
    }

    // No controls and no anomaly — wait briefly (dialog may be animating in)
    if (!snapshot.controls.length && !snapshot.questions.length) {
      await sleep(700);
      continue;
    }

    // 4. Ask the AI what to do next
    let action;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "AI_DECIDE_ACTION",
        snapshot,
      });
      if (!res || !res.ok) {
        return {
          submitted: false, answered,
          reason: "AI_DECIDE_ACTION failed: " + (res?.error || "no response"),
          turns,
        };
      }
      action = res.action;
    } catch (err) {
      return {
        submitted: false, answered,
        reason: "AI message error: " + String(err?.message ?? err),
        turns,
      };
    }

    // Lazy-fetch resume data when the AI first asks for an upload
    if (action.action === "upload" && !resumeData) {
      resumeData = await fetchResumeData();
    }

    // 5. Execute the action (with one retry on failure)
    let result = await linkedinExecutor.executeAction(action, { resumeData });

    if (!result.success && retryLimit > 0) {
      await sleep(400);
      result = await linkedinExecutor.executeAction(action, { resumeData });
    }

    // Record this turn
    answered.push({
      turn: turns,
      action: action.action,
      target: action.target || null,
      value:  action.value  || null,
      reason: action.reason || null,
      confidence: action.confidence || null,
      result: {
        success:  result.success,
        verified: result.verified,
        error:    result.error || null,
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
      // Independent verification — never trust the AI's claim alone
      await sleep(1200);
      const confirmed = linkedinIsComplete();
      return {
        submitted: confirmed, answered,
        reason: confirmed
          ? "Confirmed by LinkedIn completion indicator"
          : "AI requested finish but LinkedIn did not show a completion indicator",
        turns,
      };
    }

    // 7. Consecutive failure guard
    if (!result.success) {
      const recentFails = answered.slice(-3).filter(
        (a) => !a.result.success && a.action === action.action,
      );
      if (recentFails.length >= 3) {
        return {
          submitted: false, answered,
          reason: `action "${action.action}" on "${action.target}" failed 3 times — halting loop`,
          turns,
        };
      }
    }

    // 8. Brief human-like pause between turns
    await sleep(300);
  }

  // maxTurns reached
  const finalSubmitted = linkedinIsComplete();
  return {
    submitted: finalSubmitted, answered,
    reason: finalSubmitted
      ? "Confirmed by LinkedIn completion indicator"
      : `agent loop reached maxTurns (${maxTurns}) without confirmation`,
    turns,
  };
}

globalThis.linkedinAgentLoop = { runAgentLoop };
