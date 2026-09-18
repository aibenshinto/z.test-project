// Shared agent loop (content-script side).
//
// One observe → decide → execute → wait → observe → verify → reassess cycle,
// parameterised by a page adapter. Every site runs this same loop.
//
// The loop that existed before this change executed an action and, on failure,
// re-ran the identical action once. It had no notion of "the click worked but
// the site ignored it". This loop verifies every action against observed page
// state, escalates the interaction method, and re-observes before retrying.
//
// Submission claims are gated: `submitted: true` requires either the adapter's
// own confirmation check or an explicit confirmation message. The model saying
// "finish" is never sufficient.

(function () {
  if (globalThis.__autoApplyAgentLoopCore) return; // idempotent guard

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Consecutive ineffective actions before handing back to the user. */
  const MAX_NO_EFFECT = 3;

  const obs = () => globalThis.__autoApplyObserverCore;
  const exec = () => globalThis.__autoApplyExecutorCore;
  const core = () => globalThis.__autoApplyInteractionCore;

  function log(msg) {
    try { console.debug(msg); } catch (_) { /* non-fatal */ }
  }

  // -------------------------------------------------------------------------
  // Adapter contract
  // -------------------------------------------------------------------------

  /**
   * @typedef {object} PlatformAdapter
   * @property {string} name
   * @property {() => object} observe            Produce a UISnapshot
   * @property {() => boolean} [isComplete]      Platform-authoritative submission check
   * @property {() => string|null} [checkAnomaly] Platform CAPTCHA/login check
   * @property {() => object|null} [resumeData]  Lazy resume fetch
   * @property {number} [settleMax]              Per-platform settle bound (ms)
   */

  // -------------------------------------------------------------------------
  // Security gate — runs before every action (Part 9)
  // -------------------------------------------------------------------------

  function securityGate(adapter) {
    // An adapter may add its own check on top of the shared signals.
    const platformAnomaly = adapter.checkAnomaly?.();
    if (platformAnomaly) {
      return { blocked: true, reason: platformAnomaly, kind: "platform" };
    }
    // Generic check for sites without an adapter-specific rule.
    const verdict = core().detectSecurityChallenge(obs().securitySignals());
    return verdict.blocked ? { blocked: true, reason: verdict.reason, kind: verdict.kind } : { blocked: false };
  }

  // -------------------------------------------------------------------------
  // Submission gating (Part 21)
  // -------------------------------------------------------------------------

  function assessSubmission(adapter, { agentClaimedFinish = false } = {}) {
    return core().classifyApplicationStatus({
      adapterConfirmed: Boolean(adapter.isComplete?.()),
      pageText: obs().visibleBodyText(3000),
      successIndicators: [],
      agentClaimedFinish,
    });
  }

  // -------------------------------------------------------------------------
  // Action dispatch
  // -------------------------------------------------------------------------

  /**
   * Execute one validated action through the shared executor.
   * Returns the executor's result, which always carries a `.result` verdict.
   */
  async function dispatch(action, ctx) {
    const { action: type, target, value, direction, amount, key } = action;
    const e = exec();

    switch (type) {
      case "click":        return e.click(target, { settleMax: ctx.settleMax });
      case "double_click": return e.click(target, { settleMax: ctx.settleMax, double: true });
      case "type":         return e.type(target, value);
      case "select":       return e.select(target, value);
      case "check":        return e.setChecked(target, true, "check");
      case "uncheck":      return e.setChecked(target, false, "uncheck");
      case "upload":       return e.upload(target, await ctx.getResume());
      case "key_press":    return e.keyPress(key || value, target);
      case "scroll":       return e.scroll(direction || "down", amount || value || 600);
      case "scroll_to":    return e.scrollTo(target);
      case "go_back":      return e.historyGo(-1);
      case "go_forward":   return e.historyGo(1);

      case "wait": {
        const ms = Math.min(15000, Math.max(100, parseInt(value, 10) || 1500));
        await sleep(ms);
        // A wait always "succeeds", but waiting is not progress: it must not
        // clear the stuck-loop counter, or a model that waits between failed
        // clicks could loop until maxTurns without ever advancing.
        return { success: true, verified: true, action: "wait", ms, result: "ACTION_EXECUTED", neutral: true };
      }

      // Tab actions require the service worker — the content script cannot
      // open or switch tabs itself.
      case "navigate":
      case "open_tab":
      case "switch_tab":
      case "close_tab":
        return requestTabAction(type, action);

      case "finish":
        return { success: true, verified: true, action: "finish", finish: true, result: "ACTION_EXECUTED" };
      case "stop":
        return { success: false, verified: true, action: "stop", stopped: true, result: "ACTION_EXECUTED", reason: action.reason || "agent requested stop" };
      case "ask_user":
        return { success: false, verified: true, action: "ask_user", waitingForUser: true, result: "ACTION_EXECUTED", question: action.question || "Additional information needed" };

      default:
        return { success: false, verified: false, action: type, result: "ACTION_FAILED", error: `unhandled action: "${type}"` };
    }
  }

  /**
   * Ask the worker to perform a tab-level action. The worker validates the URL
   * — the content script never navigates to a model-supplied string directly.
   */
  async function requestTabAction(type, action) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "AGENT_TAB_ACTION",
        tabAction: type,
        url: action.value || action.url || null,
      });
      return {
        success: Boolean(res?.ok),
        verified: Boolean(res?.ok),
        action: type,
        result: res?.ok ? "ACTION_CONFIRMED" : "ACTION_FAILED",
        error: res?.ok ? null : (res?.error || "tab action was refused"),
      };
    } catch (err) {
      return { success: false, verified: false, action: type, result: "ACTION_FAILED", error: String(err?.message || err) };
    }
  }

  // -------------------------------------------------------------------------
  // Decision request
  // -------------------------------------------------------------------------

  /**
   * Ask the service worker for the next action.
   *
   * `needVisual` asks the worker to attach a screenshot. Requested only when
   * the DOM alone was not enough (Part 23) — a normal turn stays text-only.
   */
  async function decide(snapshot, { needVisual = false, lastFailure = null, job = null, instruction = "" } = {}) {
    const res = await chrome.runtime.sendMessage({
      type: "AI_DECIDE_ACTION",
      snapshot,
      needVisual,
      lastFailure,
      job,
      instruction,
    });
    if (!res?.ok) {
      throw new Error("AI_DECIDE_ACTION failed: " + (res?.error || "no response"));
    }
    return res.action;
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  /**
   * Run the agent loop for one application.
   *
   * @param {PlatformAdapter} adapter
   * @param {object} [opts]
   * @param {number} [opts.maxTurns=30]
   * @param {object} [opts.job]  { title, company } of the job being applied for
   * @param {string} [opts.instruction]  What the user told the agent to do
   * @returns {Promise<object>} { submitted, applicationStatus, answered, turns, ... }
   */
  async function run(adapter, opts = {}) {
    const maxTurns = opts.maxTurns ?? 30;
    const settleMax = adapter.settleMax ?? 2000;
    const answered = [];
    let turns = 0;
    let resumeData = null;
    let needVisual = false;
    let lastFailure = null;
    let consecutiveNoEffect = 0;

    const ctx = {
      settleMax,
      getResume: async () => {
        if (resumeData) return resumeData;
        resumeData = await (adapter.resumeData?.() ?? fetchResume());
        return resumeData;
      },
    };

    while (turns < maxTurns) {
      turns++;

      // 1. Security gate — always before anything else. Never bypass.
      const gate = securityGate(adapter);
      if (gate.blocked) {
        log(`[AGENT] Blocked: ${gate.reason}`);
        return {
          submitted: false,
          applicationStatus: core().APPLICATION_STATUS.UNKNOWN,
          answered, turns,
          stopped: true, blocked: true,
          reason: gate.reason,
        };
      }

      // 2. Already complete?
      if (adapter.isComplete?.()) {
        return {
          submitted: true,
          applicationStatus: core().APPLICATION_STATUS.SUBMITTED,
          answered, turns,
          reason: "Confirmed by the platform's own completion indicator",
        };
      }

      // 3. Observe
      log("[AGENT] Observing page");
      let snapshot;
      try {
        snapshot = adapter.observe();
      } catch (err) {
        return {
          submitted: false,
          applicationStatus: core().APPLICATION_STATUS.UNKNOWN,
          answered, turns,
          reason: "observer error: " + String(err?.message ?? err),
        };
      }

      log(`[AGENT] Found ${snapshot.elements?.length ?? 0} interactive elements`);
      for (const cand of (snapshot.applyCandidates || []).slice(0, 3)) {
        log(`[AGENT] Candidate Apply button: ${cand.id} ("${cand.name}") score=${cand.score.toFixed(2)}`);
      }

      if (snapshot.page?.applicationState === "done") {
        const verdict = assessSubmission(adapter);
        return {
          submitted: verdict.status === core().APPLICATION_STATUS.SUBMITTED,
          applicationStatus: verdict.status,
          answered, turns, reason: verdict.reason,
        };
      }

      if (snapshot.page?.applicationState === "external") {
        return {
          submitted: false,
          applicationStatus: core().APPLICATION_STATUS.NOT_SUBMITTED,
          answered, turns,
          external: true,
          reason: "External company application — handing off to the generic browser adapter.",
        };
      }

      if (snapshot.loading) { await sleep(1000); continue; }

      if (!snapshot.elements?.length && !snapshot.questions?.length) {
        // Nothing observable. Give the page a moment, then let the model look
        // at a screenshot before we conclude anything.
        if (!needVisual) { needVisual = true; await sleep(700); continue; }
      }

      // 4. Decide
      let action;
      try {
        action = await decide(snapshot, { needVisual, lastFailure, job: jobContext(opts.job), instruction: opts.instruction || "" });
        needVisual = false;
        lastFailure = null;
      } catch (err) {
        return {
          submitted: false,
          applicationStatus: core().APPLICATION_STATUS.UNKNOWN,
          answered, turns,
          reason: String(err?.message ?? err),
        };
      }

      log(`[AGENT] LLM selected ${action.action}(${action.target || action.value || ""})`);

      // 5. Execute + verify.
      // A throw from any executor must degrade to a failed action, not abort
      // the run: the loop can reassess, but a rejected promise ends the job.
      let result;
      try {
        result = await dispatch(action, ctx);
      } catch (err) {
        result = {
          success: false, verified: false, action: action.action,
          target: action.target || null,
          result: core().ACTION_RESULT.FAILED,
          error: String(err?.message || err),
        };
        log(`[EXECUTOR] ${action.action} threw: ${result.error}`);
      }

      // The click opened a new tab. From an apply control, the application
      // has moved there, so hand it to the caller to follow. Anything else —
      // a company profile, a reviews site — is a detour: close it and carry on
      // here, instead of leaving this page stalled in the background until the
      // user closes the tab by hand.
      if (result.openedTab) {
        const meta = obs().getMeta(action.target);
        if (meta && core().rankApplyIntent(meta) > 0) {
          return {
            submitted: false,
            applicationStatus: core().APPLICATION_STATUS.UNKNOWN,
            answered, turns,
            external: true,
            newTab: result.openedTab,
            reason: "The application continued in a new tab.",
          };
        }
        await closeOpenedTab(result.openedTab.id);
        result = {
          ...result,
          success: false,
          verified: false,
          result: core().ACTION_RESULT.NO_EFFECT,
          error: `this opened an unrelated page (${result.openedTab.url || "unknown"}) in a new tab, which was closed`,
        };
      }

      answered.push({
        turn: turns,
        action: action.action,
        target: action.target || null,
        value: action.value || null,
        reason: action.reason || null,
        confidence: action.confidence ?? null,
        result: {
          success: result.success,
          verified: result.verified,
          verdict: result.result || null,
          error: result.error || null,
        },
      });

      // 6. Terminal outcomes
      if (result.stopped) {
        return {
          submitted: false,
          applicationStatus: core().APPLICATION_STATUS.UNKNOWN,
          answered, turns,
          stopped: true, blocked: Boolean(result.blocked),
          reason: result.reason || "agent stopped",
        };
      }

      if (result.waitingForUser) {
        return {
          submitted: false,
          applicationStatus: core().APPLICATION_STATUS.UNKNOWN,
          answered, turns,
          waitingForUser: true,
          question: result.question,
        };
      }

      if (result.finish) {
        // Independent verification — the model's claim alone proves nothing.
        await sleep(1200);
        const verdict = assessSubmission(adapter, { agentClaimedFinish: true });
        return {
          submitted: verdict.status === core().APPLICATION_STATUS.SUBMITTED,
          applicationStatus: verdict.status,
          answered, turns,
          reason: verdict.reason,
        };
      }

      // 7. Non-terminal outcome — decide whether to escalate.
      if (result.result === core().ACTION_RESULT.NO_EFFECT ||
          result.result === core().ACTION_RESULT.FAILED ||
          result.result === core().ACTION_RESULT.STALE) {
        consecutiveNoEffect++;
        // The executor has already exhausted its DOM → pointer ladder for this
        // target. Show the model a screenshot so it can pick a different one.
        needVisual = true;
        lastFailure = {
          action: action.action,
          target: action.target || null,
          targetText: result.diagnostics?.targetText || null,
          verdict: result.result,
          error: result.error || null,
          note: "This action was executed but the website did not react. " +
                "Consider a different control, scrolling, or asking the user.",
        };
        log(`[AGENT] ${action.action} on ${action.target} → ${result.result}; reassessing with visual context`);

        if (consecutiveNoEffect >= MAX_NO_EFFECT) {
          return {
            submitted: false,
            applicationStatus: core().APPLICATION_STATUS.UNKNOWN,
            answered, turns,
            waitingForUser: true,
            question: "The agent could not make progress on this page — " +
                      `"${lastFailure.targetText || action.target}" did not respond. ` +
                      "Please take a look and continue manually, or skip this job.",
            reason: "three consecutive actions produced no observable effect",
          };
        }
      } else if (!result.neutral) {
        // Only a genuinely effective action clears the stuck counter. A wait
        // is neutral: it neither advances the flow nor proves it is stuck.
        consecutiveNoEffect = 0;
      }

      await sleep(300);
    }

    const verdict = assessSubmission(adapter);
    return {
      submitted: verdict.status === core().APPLICATION_STATUS.SUBMITTED,
      applicationStatus: verdict.status,
      answered, turns,
      reason: verdict.status === core().APPLICATION_STATUS.SUBMITTED
        ? verdict.reason
        : `agent loop reached maxTurns (${maxTurns}) without confirmation`,
    };
  }

  /** Only what the model needs to know which job this is. */
  function jobContext(job) {
    return job?.title ? { title: job.title, company: job.company || null } : null;
  }

  /** Ask the worker to close a tab this page opened, and refocus this page. */
  async function closeOpenedTab(tabId) {
    try {
      await chrome.runtime.sendMessage({ type: "CLOSE_OPENED_TAB", tabId });
    } catch (_) { /* non-fatal: the tab may already be gone */ }
  }

  async function fetchResume() {
    try {
      const ctx = await chrome.runtime.sendMessage({ type: "GET_APPLY_CONTEXT" });
      return ctx?.resume || null;
    } catch (_) {
      return null;
    }
  }

  globalThis.__autoApplyAgentLoopCore = { run, securityGate, assessSubmission, dispatch };
}());
