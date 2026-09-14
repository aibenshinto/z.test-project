// Generic (External ATS) AI Agent Loop.
//
// Claude computer-use style observe → decide → execute → verify loop for any
// company career site. Identical flow to the Naukri and LinkedIn loops.
//
// Lifecycle:
//   GENERIC_APPLY message   → start a fresh agent loop
//   GENERIC_CONTINUE message → re-observe and continue after user filled a field
//
// Termination:
//   "finish"        → verify completion text then return submitted: true
//   "stop"          → return stopped: true (CAPTCHA / challenge detected)
//   "ask_user"      → return waitingForUser: true — TAB STAYS OPEN
//   maxTurns        → return with whatever state we reached
//
// CRITICAL: submitted: true only after the completion text appears on the page
// (thank-you page / confirmation banner). The AI action "finish" alone is not
// proof of submission.

(function () {
  if (globalThis.genericAgentLoop) return; // idempotent guard

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Completion detection (ATS-agnostic)
  // ---------------------------------------------------------------------------

  function isComplete() {
    const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 3000);
    return /application (?:was )?(?:submitted|received|complete)|thank you for applying|we.ve received your application|your application has been submitted|successfully submitted/i
      .test(bodyText);
  }

  // ---------------------------------------------------------------------------
  // Resume data fetcher (lazy — only on first upload action)
  // ---------------------------------------------------------------------------

  async function fetchResumeData() {
    try {
      const ctx = await chrome.runtime.sendMessage({ type: "GET_APPLY_CONTEXT" });
      return ctx?.resume || null;
    } catch (_) { return null; }
  }

  // ---------------------------------------------------------------------------
  // Core loop
  // ---------------------------------------------------------------------------

  async function runAgentLoop({ maxTurns = 40, retryLimit = 1 } = {}) {
    const answered = [];
    let turns = 0;
    let resumeData = null;

    while (turns < maxTurns) {
      turns++;

      // 1. Completion check
      if (isComplete()) {
        return { submitted: true, answered, turns };
      }

      // 2. Observe
      let snapshot;
      try {
        snapshot = globalThis.genericObserver.observe();
      } catch (err) {
        return { submitted: false, answered, reason: "observer error: " + String(err?.message ?? err), turns };
      }

      // Blocked (CAPTCHA / login)
      if (snapshot.page?.applicationState === "blocked") {
        return {
          submitted: false, answered,
          stopped: true,
          blocked: true,
          reason: "Security or CAPTCHA challenge detected. The extension will not attempt to bypass it.",
          turns,
        };
      }
      if (snapshot.page?.applicationState === "login") {
        return {
          submitted: false, answered,
          stopped: true,
          blocked: true,
          reason: "Login wall detected. Please sign in to the company site manually, then resume.",
          turns,
        };
      }
      if (snapshot.page?.applicationState === "done") {
        return { submitted: true, answered, turns };
      }

      // Loading — wait and retry
      if (snapshot.loading) { await sleep(1200); continue; }

      // No controls visible — wait briefly (page may be navigating)
      if (!snapshot.controls.length && !snapshot.questions.length) {
        await sleep(700); continue;
      }

      // 3. Ask AI what to do next
      let action;
      try {
        const res = await chrome.runtime.sendMessage({ type: "AI_DECIDE_ACTION", snapshot });
        if (!res?.ok) {
          return { submitted: false, answered, reason: "AI_DECIDE_ACTION failed: " + (res?.error || "no response"), turns };
        }
        action = res.action;
      } catch (err) {
        return { submitted: false, answered, reason: "AI message error: " + String(err?.message ?? err), turns };
      }

      // Lazy-fetch resume data on first upload
      if (action.action === "upload" && !resumeData) {
        resumeData = await fetchResumeData();
      }

      // 4. Execute (with one retry)
      let result = await globalThis.genericExecutor.executeAction(action, { resumeData });
      if (!result.success && retryLimit > 0) {
        await sleep(400);
        result = await globalThis.genericExecutor.executeAction(action, { resumeData });
      }

      // Record
      answered.push({
        turn: turns,
        action: action.action,
        target: action.target || null,
        value:  action.value  || null,
        reason: action.reason || null,
        confidence: action.confidence || null,
        result: { success: result.success, verified: result.verified, error: result.error || null },
      });

      // 5. Terminal results

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
        // TAB STAYS OPEN — the session saves this state and waits for user
        return {
          submitted: false, answered,
          waitingForUser: true,
          question: result.question || action.question || "Additional information required",
          turns,
        };
      }

      if (result.action === "finish" || result.finish) {
        await sleep(1500);
        const confirmed = isComplete();
        return {
          submitted: confirmed, answered,
          reason: confirmed
            ? "Confirmed by application completion text"
            : "AI requested finish but no completion confirmation was found on the page",
          turns,
        };
      }

      // Consecutive failure guard (3 identical failures = halt)
      if (!result.success) {
        const recentFails = answered.slice(-3).filter(
          (a) => !a.result.success && a.action === action.action,
        );
        if (recentFails.length >= 3) {
          return {
            submitted: false, answered,
            reason: `action "${action.action}" on "${action.target}" failed 3 times — halting`,
            turns,
          };
        }
      }

      // Human-like pacing between turns
      await sleep(350);
    }

    const finalSubmitted = isComplete();
    return {
      submitted: finalSubmitted, answered,
      reason: finalSubmitted
        ? "Confirmed by application completion text"
        : `agent loop reached maxTurns (${maxTurns}) without confirmation`,
      turns,
    };
  }

  // ---------------------------------------------------------------------------
  // Message listener — handles both start and resume
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "GENERIC_APPLY" && msg.type !== "GENERIC_CONTINUE") return;

    // On GENERIC_CONTINUE (user filled a field manually), just re-run the loop
    // from the current DOM state. The loop will observe fresh and pick up where
    // the user left off.
    runAgentLoop()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err)   => sendResponse({ ok: false, error: String(err?.message || err) }));

    return true; // keep message channel open
  });

  globalThis.genericAgentLoop = { runAgentLoop };
}());
