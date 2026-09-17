// Takeover session — the agent working the page you are already looking at.
//
// This replaces the background-queue model for interactive runs. The previous
// design read a stored job queue and opened its own tabs; here the user has
// already signed in and run the search they want, and the agent takes over
// that tab and works down the visible results while the user watches.
//
//   you search on any job board
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
  // Page adapter
  // -------------------------------------------------------------------------

  /**
   * The adapter for whatever page we are on right now.
   *
   * There is one, and it reads any page: an application is found by what the
   * page offers, not by which site it is. A run crosses sites constantly — a
   * board's result opens the company's own ATS, which opens a third-party
   * form — and none of those hops need the agent to know the site.
   */
  function adapterForCurrentPage() {
    return globalThis.genericAgentLoop?.adapter || null;
  }

  /** A URL that is a search rather than one job. */
  const SEARCH_URL = /(?:\/search\b|\bjobs?-in-|[?&](?:q|query|keyword|keywords|what|searchTerm)=)/i;

  /**
   * Is this page a list of results, or one job?
   *
   * Counting job links is not enough: a job's own page carries a rail of
   * other jobs ("similar jobs", "people also viewed"), and walking that rail
   * means applying to everything except the job the user opened. So a page
   * that is itself a job is a job, however many others it links to.
   */
  function onResultsPage() {
    if (walker().findJobs().length < 2) return false;
    if (SEARCH_URL.test(location.href)) return true;
    return !walker().looksLikeJobLink(location.href);
  }

  // -------------------------------------------------------------------------
  // Applying to one job
  // -------------------------------------------------------------------------

  /**
   * Drive one job to a conclusion: open the application, fill it, verify.
   *
   * Runs wherever the job took us — the board's own page, an apply dialog,
   * or a company ATS in a new tab — by reading whatever page it is on.
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

      // A page often lists every opening with its own Apply — a company
      // careers page, or a board that shows the job in a pane beside the
      // results. Only this job's Apply will do; the first one on the page is
      // usually a different job.
      const listed = applyControlForJob(job);
      if (listed && !listed.element) {
        return { submitted: false, reason: `this page lists several jobs, but not "${job.title}"` };
      }

      const opened = await loop().openApplication({
        hint: listed ? () => listed.element : undefined,
        snapshot: listed ? { ...snapshot, applyCandidates: [] } : snapshot,
        opened: () => applicationStarted(adapter),
        settleMax: TIMING.settleMax,
        openWaitMs: TIMING.openWaitMs,
        budgetMs: TIMING.applyBudgetMs,
      });

      if (!opened.opened) {
        return { submitted: false, reason: opened.reason, tried: opened.tried };
      }

      // The apply control opened the application in a new tab (usually the
      // company's own site). Follow it there.
      if (opened.newTab) return followOpenedApplication(opened.newTab, job);
    }

    // Hand the form itself to the shared agent loop.
    report({ phase: "form", job: job?.title, note: "Filling the application" });
    const outcome = await loop().run(adapter, { maxTurns: 30, job });

    // An apply control part-way through the form moved it to a new tab.
    if (outcome.newTab) return followOpenedApplication(outcome.newTab, job);
    return outcome;
  }

  async function followOpenedApplication(tab, job) {
    return (await followNewTab({ tabId: tab.id, job })) ||
      { submitted: false, reason: "the application opened in a new tab that closed before it could be followed" };
  }

  /** Has an application actually started on this page? */
  function applicationStarted(adapter) {
    const state = adapter.observe().page.applicationState;
    return state === "applying" || state === "chatbot" ||
           state === "questionnaire" || state === "done";
  }

  // -------------------------------------------------------------------------
  // Pages that list several jobs
  // -------------------------------------------------------------------------

  const APPLY_NAME = /^(?:apply|apply now|apply here|apply online|quick apply|easy apply)$/i;
  const TITLE_NOISE = new Set(["and", "for", "the", "with", "of", "in", "to", "at", "or", "job", "role", "level", "years", "year", "yrs", "yr"]);

  function titleWords(text) {
    return String(text || "").toLowerCase().split(/[^a-z0-9+#]+/)
      .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !TITLE_NOISE.has(w));
  }

  /** Share of the job title's words that appear in `text`, 0..1. */
  function titleMatch(title, text) {
    const wanted = titleWords(title);
    const have = new Set(titleWords(text));
    return wanted.length ? wanted.filter((w) => have.has(w)).length / wanted.length : 0;
  }

  /**
   * On a page listing several jobs, each with its own Apply, find the Apply
   * in the row that names this job.
   *
   * @returns {null | {element: Element|null}}  null when the page is not such
   *   a list; `element` is null when the list does not include this job.
   */
  function applyControlForJob(job) {
    if (!job?.title) return null;
    const controls = [...document.querySelectorAll("a, button, [role='button'], input[type='submit'], input[type='button']")]
      .filter((el) => obs().isVisible(el) && APPLY_NAME.test(core().accessibleName(obs().describe(el))));
    if (controls.length < 2) return null;

    // The job's own page may repeat its Apply at the top and bottom; a page
    // headed with this job's title is not a list of other jobs.
    const heading = [document.title, ...[...document.querySelectorAll("h1")].map((h) => obs().innerText(h))].join(" ");
    if (titleMatch(job.title, heading) >= 0.6) return null;

    let best = null;
    for (const control of controls) {
      const score = titleMatch(job.title, obs().innerText(rowFor(control, controls)));
      if (!best || score > best.score) best = { control, score };
    }
    return { element: best.score >= 0.6 ? best.control : null };
  }

  /** The largest ancestor of `control` holding no other listed control: its row. */
  function rowFor(control, controls) {
    let row = control;
    while (row.parentElement && row.parentElement !== document.body &&
           !controls.some((other) => other !== control && row.parentElement.contains(other))) {
      row = row.parentElement;
    }
    return row;
  }

  // -------------------------------------------------------------------------
  // Returning to the results
  // -------------------------------------------------------------------------

  /**
   * Get back to the results list after finishing a job.
   *
   * On a board that renders the detail in a pane the list never went away, so
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

          // Only jobs that fit the candidate's profile are opened at all.
          const fit = await checkFit(job);
          if (fit.error) {
            return { ...summarize(applied, skipped, fit.error), ok: false, error: fit.error };
          }
          // The rate governor has had enough for now — a daily or hourly cap,
          // or the breaker tripped. That ends the run rather than skipping a
          // job: the next job would be refused for the same reason.
          if (fit.decision === "STOP") {
            return summarize(applied, skipped, `stopped: ${fit.reason}`);
          }
          if (fit.decision !== "APPLY") {
            skipped.push({ ...stripJob(job), reason: fit.reason });
            report({ phase: "skip", job: job.title, note: fit.reason });
            continue;
          }

          report({ phase: "open", job: job.title, company: job.company, note: `Opening "${job.title.slice(0, 50)}"` });

          const clickedAt = Date.now();
          const opened = await walker().openJob(
            job,
            () => jobIsOpen(job),
            { settleMax: TIMING.settleMax, openWaitMs: TIMING.openWaitMs },
          );

          // A job that opened in a NEW tab cannot be driven from here: a
          // content script only sees its own tab. The worker runs it there and
          // reports back. `since` also catches a tab that appeared too late
          // for the click itself to notice.
          const followed = await followNewTab({ tabId: opened.newTab?.id, since: clickedAt, job: stripJob(job) }) ||
            (opened.newTab && { submitted: false, reason: "the job's new tab closed before the agent could follow it" });
          if (followed) {
            recordOutcome(followed, job, applied, skipped);
            const ended = endOfRun(followed, applied, skipped);
            if (ended) return ended;
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

          const ended = endOfRun(outcome, applied, skipped);
          if (ended) return ended;

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
   * A security challenge or a question for the user ends the run with the
   * page left where they can see and act on it — whichever tab that is.
   * Returns the run summary, or null when the run should carry on.
   */
  function endOfRun(outcome, applied, skipped) {
    if (outcome.blocked || outcome.stopped) {
      return summarize(applied, skipped, outcome.reason, { blocked: true });
    }
    if (outcome.waitingForUser) {
      return summarize(applied, skipped, outcome.question, { waitingForUser: true, question: outcome.question });
    }
    return null;
  }

  /**
   * Hand a tab this page opened to the worker, which focuses it, runs the
   * application there and reports back.
   *
   * @param {object} which
   * @param {number} [which.tabId]  A tab the click is known to have opened
   * @param {number} [which.since]  Otherwise, any tab this page opened after this time (ms)
   * @param {object} [which.job]    The job being applied for, so the new page knows
   * @returns {Promise<object|null>} The application outcome, or null when no tab was opened
   */
  async function followNewTab({ tabId, since, job }) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "TAKEOVER_ADOPT_NEW_TAB", tabId, since, job: job ? stripJob(job) : null,
      });
      if (!res?.adopted) return null;
      report({ phase: "external", note: "Continued in the new tab" });
      return res.result || { submitted: false, reason: res.error || "the new tab did not report a result" };
    } catch (_) {
      return null;
    }
  }

  /**
   * Ask the worker whether this job fits the candidate's profile, from what
   * its results card shows.
   * @returns {Promise<{decision: string, reason: string} | {error: string}>}
   */
  async function checkFit(job) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "TAKEOVER_EVALUATE_JOB", job: { ...stripJob(job), text: job.text || "" },
      });
      if (!res?.ok) return { error: res?.error || "could not check this job against your profile" };
      return { decision: res.decision, reason: res.reason || "" };
    } catch (err) {
      return { error: `could not check this job against your profile: ${String(err?.message || err)}` };
    }
  }

  function applicationAvailable() {
    const adapter = adapterForCurrentPage();
    if (!adapter) return false;
    const state = adapter.observe().page.applicationState;
    return state !== "unknown";
  }

  /**
   * Is the job the agent just clicked the one now open?
   *
   * The boards the agent is used on most show the job in a pane beside the
   * results, so the list never goes away and the URL may not change. "The
   * page offers an application" is no help either: a results page full of
   * Apply buttons offers one before anything is clicked, so every job would
   * read as opened the instant it was clicked, and the agent would apply to
   * whatever the pane happened to be showing. This asks the only question
   * that distinguishes them — is *this* job what the page is showing now?
   */
  function jobIsOpen(job) {
    if (walker().canonicalJobUrl(location.href) === job.id) return true;

    const headings = [
      document.title,
      ...[...document.querySelectorAll("h1, h2, [role='heading']")]
        .filter((el) => obs().isVisible(el)).slice(0, 8).map((el) => obs().innerText(el)),
    ].join(" ");
    if (titleMatch(job.title, headings) >= 0.6) return true;

    // A page that stopped being a list has navigated somewhere — the job's
    // own page, or the application itself.
    return !onResultsPage() && applicationAvailable();
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
      chrome.runtime.sendMessage({ type: "RECORD_SUBMIT", payload: { ...entry, site: window.location.hostname } }).catch(() => {});
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
    applyToOpenJob, adapterForCurrentPage, onResultsPage, returnToResults, jobIsOpen,
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
        applyToOpenJob(msg.job || null)
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
