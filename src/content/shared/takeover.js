// Takeover session — the agent working the page you are already looking at.
//
// This replaces the background-queue model for interactive runs. The previous
// design read a stored job queue and opened its own tabs; here the user has
// already signed in and run the search they want, and the agent takes over
// that tab and works down the visible results while the user watches.
//
//   you search on Naukri/LinkedIn
//        ↓  press Start
//   walk the visible results
//        ↓
//   open job → apply (dialog, form, or external site) → verify
//        ↓
//   back to the results → next job → … → next page
//
// The agent never opens a hidden tab and never closes the user's tab. Anything
// it cannot do itself — a CAPTCHA, an unanswerable question — pauses the run
// and hands control back, with the page left exactly where the user can see it.

(function () {
  if (globalThis.__autoApplyTakeover) return; // idempotent guard

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Pacing, in one place so it can be tuned for a slow site and collapsed in
  // tests. Real runs keep the defaults; nothing here changes behaviour, only
  // how long the agent waits for a page to catch up.
  const TIMING = {
    settleMax: 3000,      // how long a click waits for the site to react
    openWaitMs: 4000,     // how long to wait for a job detail / apply UI to show
    applyBudgetMs: 20000, // total time spent trying apply controls on one job
    afterOpen: 800,       // let a job detail render before reading it
    betweenJobs: 600,     // a human-ish pause between applications
    afterPage: 1500,      // after advancing to the next results page
    backAttempts: 3,      // history.back() tries before falling back to the URL
    backWait: 1200,       // how long to wait for each back() to land
  };

  function configure(overrides = {}) {
    Object.assign(TIMING, overrides);
    return { ...TIMING };
  }

  const obs = () => globalThis.__autoApplyObserverCore;
  const core = () => globalThis.__autoApplyInteractionCore;
  const loop = () => globalThis.__autoApplyAgentLoopCore;
  const walker = () => globalThis.__autoApplyResultsWalker;
  const cursor = () => globalThis.__autoApplyCursor;

  /** Jobs already handled in this run, so a re-scan does not repeat them. */
  const visited = new Set();

  let running = false;
  let stopRequested = false;
  let paused = false;

  function log(msg) {
    try { console.debug(msg); } catch (_) { /* non-fatal */ }
  }

  /** Tell the side panel what is happening, without blocking on it. */
  function report(event) {
    try {
      chrome.runtime.sendMessage({ type: "TAKEOVER_PROGRESS", ...event }).catch(() => {});
    } catch (_) { /* the tab may be navigating */ }
    cursor()?.setNote(event.note || "");
  }

  // -------------------------------------------------------------------------
  // Platform adapter selection
  // -------------------------------------------------------------------------

  /**
   * Pick the adapter for whatever page we are on right now.
   *
   * This is re-evaluated on every job, because a single run legitimately
   * crosses sites: a Naukri result can redirect to a company's own ATS, and
   * from that point the generic adapter is the correct one.
   */
  function adapterForCurrentPage() {
    const host = location.hostname;
    if (/(^|\.)naukri\.com$/i.test(host) && globalThis.naukriAgentLoop) {
      return globalThis.naukriAgentLoop.adapter;
    }
    if (/(^|\.)linkedin\.com$/i.test(host) && globalThis.linkedinAgentLoop) {
      return globalThis.linkedinAgentLoop.adapter;
    }
    return globalThis.genericAgentLoop?.adapter || null;
  }

  /** Is this page a search-results list rather than a single job? */
  function onResultsPage() {
    return walker().findJobs().length >= 2;
  }

  // -------------------------------------------------------------------------
  // Applying to one job
  // -------------------------------------------------------------------------

  /**
   * Drive one job to a conclusion: open the application, fill it, verify.
   *
   * Runs wherever the job took us — the same Naukri page, an Easy Apply
   * dialog, or a company ATS in a new tab — by re-selecting the adapter for
   * the page the agent is actually on.
   */
  async function applyToOpenJob(job) {
    const adapter = adapterForCurrentPage();
    if (!adapter) {
      return { submitted: false, reason: "no adapter is available for this site" };
    }

    // Security gate first, always.
    const gate = loop().securityGate(adapter);
    if (gate.blocked) {
      return { submitted: false, blocked: true, stopped: true, reason: gate.reason };
    }

    const snapshot = adapter.observe();

    // Already applied — nothing to do.
    if (adapter.isComplete?.()) {
      return {
        submitted: true,
        applicationStatus: core().APPLICATION_STATUS.SUBMITTED,
        reason: "already applied",
      };
    }

    // If the application has not been started, start it.
    if (snapshot.page.applicationState === "ready" ||
        snapshot.page.applicationState === "unknown") {
      report({ phase: "apply", job: job?.title, note: "Looking for the apply button" });

      const opened = await loop().openApplication({
        hint: platformApplyHint(),
        snapshot,
        opened: () => applicationStarted(adapter),
        settleMax: TIMING.settleMax,
        openWaitMs: TIMING.openWaitMs,
        budgetMs: TIMING.applyBudgetMs,
      });

      if (!opened.opened) {
        return { submitted: false, reason: opened.reason, tried: opened.tried };
      }
    }

    // Hand the form itself to the shared agent loop.
    report({ phase: "form", job: job?.title, note: "Filling the application" });
    return loop().run(adapter, { maxTurns: 30 });
  }

  /** Has an application actually started on this page? */
  function applicationStarted(adapter) {
    const state = adapter.observe().page.applicationState;
    return state === "applying" || state === "chatbot" ||
           state === "questionnaire" || state === "done";
  }

  /** The platform's own apply-button locator, when it has one. */
  function platformApplyHint() {
    const host = location.hostname;
    if (/(^|\.)linkedin\.com$/i.test(host) && globalThis.LINKEDIN_SEL) {
      return () => globalThis.LINKEDIN_SEL.job.easyApply();
    }
    if (/(^|\.)naukri\.com$/i.test(host) && globalThis.NAUKRI_SEL) {
      return () => [...document.querySelectorAll(globalThis.NAUKRI_SEL.job.applyButton)]
        .find((el) => obs().isVisible(el)) || null;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Returning to the results
  // -------------------------------------------------------------------------

  /**
   * Get back to the results list after finishing a job.
   *
   * On LinkedIn the list never went away (the detail renders in a pane), so
   * this is usually a no-op. Where the job replaced the page, history.back()
   * returns to the search the user ran — which is why the agent navigates by
   * going back rather than by re-running the search itself.
   */
  async function returnToResults(resultsUrl) {
    if (onResultsPage()) return true;

    report({ phase: "navigate", note: "Back to the results" });

    for (let attempt = 0; attempt < TIMING.backAttempts; attempt++) {
      history.back();
      await sleep(TIMING.backWait);
      if (onResultsPage()) return true;
    }

    // History did not get us back (a new tab, or a replaced history entry).
    if (resultsUrl && location.href !== resultsUrl) {
      location.href = resultsUrl;
      await sleep(2000);
      return onResultsPage();
    }
    return onResultsPage();
  }

  // -------------------------------------------------------------------------
  // The run
  // -------------------------------------------------------------------------

  /**
   * Take over this page and work through the visible job results.
   *
   * @param {object} [opts]
   * @param {number} [opts.maxJobs=25]   Stop after this many jobs
   * @param {number} [opts.maxPages=3]   Stop after this many result pages
   * @returns {Promise<object>} summary
   */
  async function run(opts = {}) {
    if (running) return { ok: false, error: "a takeover run is already in progress" };

    running = true;
    stopRequested = false;
    paused = false;

    const maxJobs = opts.maxJobs ?? 25;
    const maxPages = opts.maxPages ?? 3;
    const resultsUrl = location.href;
    const applied = [];
    const skipped = [];
    let page = 0;

    cursor()?.show();
    report({ phase: "start", note: "Agent has taken over this page" });

    try {
      while (page < maxPages && applied.length + skipped.length < maxJobs) {
        page++;

        const jobs = walker().findJobs().filter((j) => !visited.has(j.id));
        log(`[TAKEOVER] Page ${page}: ${jobs.length} unvisited job(s)`);

        if (!jobs.length) {
          // No jobs here. Either the user is on a single job page, or we have
          // exhausted this page and should try the next one.
          if (page === 1 && !onResultsPage()) {
            report({ phase: "single", note: "Applying to this job" });
            const single = await applyToOpenJob(null);
            recordOutcome(single, { title: document.title }, applied, skipped);
            return summarize(applied, skipped, "single job");
          }
          if (!(await walker().goToNextPage())) break;
          await sleep(TIMING.afterPage);
          continue;
        }

        for (const job of jobs) {
          if (stopRequested) return summarize(applied, skipped, "stopped by user");
          while (paused && !stopRequested) await sleep(500);
          if (stopRequested) return summarize(applied, skipped, "stopped by user");
          if (applied.length + skipped.length >= maxJobs) break;

          visited.add(job.id);
          report({ phase: "open", job: job.title, company: job.company, note: `Opening "${job.title.slice(0, 50)}"` });

          const opened = await walker().openJob(
            job,
            () => !onResultsPage() || applicationAvailable(),
            { settleMax: TIMING.settleMax, openWaitMs: TIMING.openWaitMs },
          );

          // A job that opened in a NEW tab cannot be driven from here: a
          // content script only sees its own tab. Ask the worker to run it
          // there and report back.
          const adopted = await adoptNewTabIfAny();
          if (adopted.adopted) {
            recordOutcome(adopted.result || { submitted: false, reason: adopted.error }, job, applied, skipped);
            await sleep(TIMING.betweenJobs);
            continue;
          }

          if (!opened.opened) {
            skipped.push({ ...stripJob(job), reason: opened.reason });
            report({ phase: "skip", job: job.title, note: opened.reason });
            continue;
          }

          await sleep(TIMING.afterOpen); // let the detail settle

          const outcome = await applyToOpenJob(job);
          recordOutcome(outcome, job, applied, skipped);

          // A security challenge or a question for the user ends the run with
          // the page left where they can see and act on it.
          if (outcome.blocked || outcome.stopped) {
            return summarize(applied, skipped, outcome.reason, { blocked: true });
          }
          if (outcome.waitingForUser) {
            return summarize(applied, skipped, outcome.question, { waitingForUser: true, question: outcome.question });
          }

          if (!(await returnToResults(resultsUrl))) {
            return summarize(applied, skipped, "could not get back to the results list");
          }
          await sleep(TIMING.betweenJobs);
        }

        if (applied.length + skipped.length >= maxJobs) break;
        if (!(await walker().goToNextPage())) break;
        await sleep(TIMING.afterPage);
      }

      return summarize(applied, skipped, "finished the visible results");
    } finally {
      running = false;
      cursor()?.clearNote();
    }
  }

  /**
   * If the last click opened a new tab, hand that tab to the worker to drive.
   * Returns { adopted: false } when nothing new opened, which is the usual case.
   */
  async function adoptNewTabIfAny() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "TAKEOVER_ADOPT_NEW_TAB" });
      if (res?.adopted) report({ phase: "external", note: "Continuing in the company's own tab" });
      return res || { adopted: false };
    } catch (_) {
      return { adopted: false };
    }
  }

  function applicationAvailable() {
    const adapter = adapterForCurrentPage();
    if (!adapter) return false;
    const state = adapter.observe().page.applicationState;
    return state !== "unknown";
  }

  function stripJob(job) {
    return { id: job.id, title: job.title, company: job.company, url: job.url };
  }

  function recordOutcome(outcome, job, applied, skipped) {
    const entry = {
      ...stripJob(job || { id: location.href, title: document.title, company: "", url: location.href }),
      applicationStatus: outcome.applicationStatus || core().APPLICATION_STATUS.UNKNOWN,
      reason: outcome.reason || outcome.question || null,
    };
    if (outcome.submitted) {
      applied.push(entry);
      report({ phase: "applied", job: entry.title, note: `Applied to "${String(entry.title).slice(0, 40)}"` });
    } else {
      skipped.push(entry);
      report({ phase: "skip", job: entry.title, note: entry.reason || "not submitted" });
    }
  }

  function summarize(applied, skipped, reason, extra = {}) {
    const summary = {
      ok: true,
      applied,
      skipped,
      appliedCount: applied.length,
      skippedCount: skipped.length,
      reason,
      ...extra,
    };
    report({ phase: "done", note: `${applied.length} applied, ${skipped.length} skipped` });
    return summary;
  }

  function stop() { stopRequested = true; paused = false; }
  function pause() { paused = true; }
  function resume() { paused = false; }
  function isRunning() { return running; }
  function reset() { visited.clear(); }

  globalThis.__autoApplyTakeover = {
    run, stop, pause, resume, isRunning, reset, configure,
    applyToOpenJob, adapterForCurrentPage, onResultsPage, returnToResults,
  };

  // -------------------------------------------------------------------------
  // Messages from the side panel
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "TAKEOVER_START":
        run(msg.options || {})
          .then((r) => sendResponse(r))
          .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
        return true;

      case "TAKEOVER_APPLY_HERE":
        // The worker followed a job into this tab and wants the application
        // completed here, then control handed back.
        cursor()?.show();
        applyToOpenJob(null)
          .then((r) => sendResponse(r))
          .catch((err) => sendResponse({ submitted: false, reason: String(err?.message || err) }));
        return true;

      case "TAKEOVER_STOP":   stop();   sendResponse({ ok: true }); return false;
      case "TAKEOVER_PAUSE":  pause();  sendResponse({ ok: true }); return false;
      case "TAKEOVER_RESUME": resume(); sendResponse({ ok: true }); return false;

      case "TAKEOVER_STATUS":
        sendResponse({ ok: true, running: isRunning(), url: location.href });
        return false;

      case "SET_CURSOR_VISIBLE":
        cursor()?.setEnabled(msg.visible !== false);
        sendResponse({ ok: true });
        return false;

      case "TAKEOVER_PROBE":
        // Used by the panel to tell the user what pressing Start would do.
        sendResponse({
          ok: true,
          onResultsPage: onResultsPage(),
          jobCount: walker().findJobs().length,
          url: location.href,
          title: document.title,
        });
        return false;

      default:
        return false;
    }
  });
}());
