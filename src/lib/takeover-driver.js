// Takeover driver — the run, from the worker's side.
//
// Pure module: everything it touches in the browser comes in through `deps`,
// so the whole run can be driven with fakes in `node --test`.
//
// The run used to live in the page. That had two costs. A page that navigated
// took the run with it — and on a job board, Apply navigating the tab is
// normal. And the page decided what it was looking at by rules: whether the
// job's title appeared in the headings, whether its links repeated like a
// list. On a search results page the headings ARE the job titles, so every
// job read as "open" the moment it was clicked, and the agent went looking
// for Apply on the results list.
//
// Now the page is only eyes and hands: it describes itself and performs one
// action at a time. What a page is — a list of jobs, one job, an application,
// a confirmation — is the model's reading of it (src/lib/page-agent.js), and
// this driver acts on that reading. Three things stay in code, because they
// must not depend on a model's judgement: the security gate, the rate
// governor, and proof that an application was really submitted.

import { APPLICATION_STATUS, ACTION_RESULT } from "./interaction-core.js";
import { DEFAULT_INSTRUCTION } from "./page-agent.js";

/** Bounds that keep one confused page from running forever. */
export const LIMITS = {
  stepsPerJob: 15,    // page readings spent on one job before giving up on it
  loadingWaits: 4,    // readings of a page that is still loading
  wander: 3,          // clicks toward the instruction on pages that are neither list nor job
  applyFailures: 2,   // apply clicks the page ignores before the job is skipped
  backToList: 2,      // attempts to return to the results before the run ends
};

/** Pacing. Collapsed to zero in tests through `deps.sleep`. */
export const TIMING = {
  afterClick: 800,    // let a page react before it is read again
  loadingWait: 1500,  // between readings of a page that is still loading
  betweenJobs: 600,
  afterPage: 1500,
};

const INEFFECTIVE = new Set([ACTION_RESULT.NO_EFFECT, ACTION_RESULT.FAILED, ACTION_RESULT.STALE]);

/**
 * Take over a tab and do what the user asked, reading every page first.
 *
 * @param {object} deps    Browser access; see tests/takeover-driver.test.js for the full set
 * @param {object} opts
 * @param {number} opts.tabId
 * @param {string} [opts.instruction]
 * @param {number} [opts.maxJobs=25]
 * @param {number} [opts.maxPages=3]
 * @returns {Promise<object>} summary
 */
export async function runTakeover(deps, opts = {}) {
  const run = {
    deps,
    instruction: String(opts.instruction || "").trim() || DEFAULT_INSTRUCTION,
    maxJobs: opts.maxJobs ?? 25,
    maxPages: opts.maxPages ?? 3,
    applied: [],
    skipped: [],
    visited: new Set(),
  };
  let tabId = opts.tabId;

  report(run, tabId, { phase: "start", note: "Agent has taken over this page" });

  let page = 1;
  let wander = 0;
  let returns = 0;
  let listUrl = null;
  // Every pass either visits a job, turns a page, takes a step toward the
  // instruction or ends, so this bound is only ever a backstop.
  const maxPasses = run.maxJobs * 2 + run.maxPages * 2 + LIMITS.wander + 10;

  try {
    for (let pass = 0; pass < maxPasses; pass++) {
      if (deps.control.stopped()) return summarize(run, "stopped by user");
      await deps.control.waitIfPaused();
      if (done(run) >= run.maxJobs) return summarize(run, `reached the limit of ${run.maxJobs} jobs`);

      const seen = await look(run, tabId, {});
      if (seen.end) return summarize(run, seen.end.reason, endFlags(seen.end));
      const { reading, view } = seen;

      if (reading.pageType !== "job_list") {
        // The user started on one job, or on its application.
        const onOneJob = ["job_detail", "application_form", "application_submitted"].includes(reading.pageType);
        if (onOneJob && !listUrl) {
          const job = {
            title: reading.shownJob.title || view.title || "this job",
            company: reading.shownJob.company,
            url: view.url,
          };
          report(run, tabId, { phase: "single", job: job.title, note: "Applying to this job" });
          const outcome = await applyToJob(run, tabId, job);
          record(run, tabId, job, outcome);
          return summarize(run, outcome.reason || "applied to the job on this page", endFlags(outcome));
        }

        // A job ended somewhere other than the results: go back to them
        // before anything else.
        if (listUrl && returns < LIMITS.backToList) {
          returns++;
          await backToList(run, tabId, listUrl);
          continue;
        }

        // Somewhere else: take one step toward what the user asked for.
        if (reading.pageType === "other" && reading.towardGoalTarget && wander < LIMITS.wander) {
          wander++;
          report(run, tabId, { phase: "navigate", note: reading.summary });
          const moved = await click(run, tabId, reading.towardGoalTarget);
          // A careers link that opens a new tab: carry on there, in front of the user.
          if (moved.openedTab) {
            tabId = moved.openedTab.id;
            await deps.focusTab(tabId);
            await deps.waitForLoad(tabId);
          }
          continue;
        }

        return summarize(run, `Nothing to apply to here: ${reading.summary}`);
      }

      listUrl = view.url;
      returns = 0;

      const links = await deps.jobLinks(tabId, reading.jobs.map((job) => job.target)) || [];
      const byTarget = new Map(links.map((link) => [link.target, link]));
      const jobs = reading.jobs
        .map((job) => withLink(job, byTarget.get(job.target)))
        .filter((job) => !run.visited.has(job.key));

      if (!jobs.length) {
        if (reading.nextPageTarget && page < run.maxPages) {
          report(run, tabId, { phase: "page", note: "Next page of results" });
          const moved = await click(run, tabId, reading.nextPageTarget);
          if (moved.failed || moved.openedTab) return summarize(run, "The next page of results did not load");
          page++;
          await deps.sleep(TIMING.afterPage);
          continue;
        }
        return summarize(run, reading.jobs.length ? "finished the visible results" : `No jobs found on this page: ${reading.summary}`);
      }

      for (const job of jobs) {
        if (deps.control.stopped()) return summarize(run, "stopped by user");
        await deps.control.waitIfPaused();
        if (done(run) >= run.maxJobs) return summarize(run, `reached the limit of ${run.maxJobs} jobs`);

        // A page can list one job twice — promoted at the top, then again in place.
        if (run.visited.has(job.key)) continue;
        run.visited.add(job.key);

        // Only jobs that fit the candidate are opened at all.
        const fit = await deps.evaluate(job);
        if (fit.error) return summarize(run, fit.error, { ok: false, error: fit.error });
        // The rate governor has had enough for now. The next job would be
        // refused for the same reason, so the run ends rather than skipping.
        if (fit.decision === "STOP") return summarize(run, `stopped: ${fit.reason}`);
        if (fit.decision !== "APPLY") {
          record(run, tabId, job, { submitted: false, reason: fit.reason });
          continue;
        }

        const opened = await openAndApply(run, tabId, job);
        record(run, tabId, job, opened.outcome);
        if (holdsTab(opened.outcome)) return summarize(run, opened.outcome.reason || opened.outcome.question, endFlags(opened.outcome));

        // The job used this tab: the list's elements were read again or the
        // page moved, so read the list afresh before the next job.
        if (opened.leftList) await backToList(run, tabId, listUrl);
        if (opened.leftList || opened.sameTab) break;
        await deps.sleep(TIMING.betweenJobs);
      }
    }
    return summarize(run, "stopped after too many steps");
  } finally {
    await deps.done?.(tabId);
  }
}

// ---------------------------------------------------------------------------
// One job
// ---------------------------------------------------------------------------

/**
 * Open one job from the list, and see it through.
 *
 * @returns {Promise<{outcome: object, leftList?: boolean, sameTab?: boolean}>}
 */
async function openAndApply(run, listTabId, job) {
  const { deps } = run;
  report(run, listTabId, { phase: "open", job: job.title, company: job.company, note: `Opening "${job.title.slice(0, 50)}"` });

  // A link that opens a new tab is opened by the worker. To Chrome a scripted
  // click on one is a pop-up, and it blocks those once the user's own last
  // click on the page is a few seconds old.
  if (job.newTab && job.url) {
    const tab = await deps.openTab(listTabId, job.url, { pointAt: job.target });
    if (tab) return { outcome: await followTab(run, listTabId, tab, job) };
  }

  const moved = await click(run, listTabId, job.target);
  if (moved.openedTab) return { outcome: await followTab(run, listTabId, moved.openedTab, job) };

  if (!moved.failed) {
    // Same tab: either the page went to the job, or the job opened beside
    // the list. The reading says which — and whether it opened at all.
    const outcome = await applyToJob(run, listTabId, job);
    if (!outcome.notOpened || !job.url) {
      return { outcome, leftList: Boolean(moved.navigated), sameTab: true };
    }
  }

  // The click opened nothing — a blocked pop-up, or a card that answers only
  // a real hand. The job's own address still works.
  const leftList = Boolean(moved.navigated);
  const sameTab = !moved.failed;
  if (job.url) {
    const tab = await deps.openTab(listTabId, job.url, { pointAt: job.target });
    if (tab) return { outcome: await followTab(run, listTabId, tab, job), leftList, sameTab };
  }
  return {
    outcome: { submitted: false, reason: `Clicking "${job.title.slice(0, 60)}" opened nothing, and it has no link to follow` },
    leftList,
    sameTab,
  };
}

/**
 * Drive one job to a conclusion in `tabId`, reading the page before every
 * step: open its application, fill it, confirm it.
 */
export async function applyToJob(run, tabId, job) {
  const { deps } = run;
  let lastStep = "";
  let failures = 0;
  let wander = 0;

  for (let step = 0; step < LIMITS.stepsPerJob; step++) {
    if (deps.control.stopped()) return { submitted: false, stopped: true, byUser: true, reason: "stopped by user" };
    await deps.control.waitIfPaused();

    const seen = await look(run, tabId, { job, lastStep });
    if (seen.end) return seen.end;
    const { reading } = seen;
    report(run, tabId, { phase: reading.pageType, job: job.title, note: reading.summary });

    switch (reading.pageType) {
      case "application_submitted": {
        // The model's reading is not proof. The page has to say so too.
        if (await deps.verifySubmitted(tabId)) {
          return { submitted: true, applicationStatus: APPLICATION_STATUS.SUBMITTED, reason: reading.summary };
        }
        return {
          submitted: false,
          applicationStatus: APPLICATION_STATUS.UNKNOWN,
          reason: `The page looks like a confirmation, but it does not say so in a way that can be verified: ${reading.summary}`,
        };
      }

      case "application_form": {
        report(run, tabId, { phase: "form", job: job.title, note: "Filling the application" });
        let outcome = await deps.fill(tabId, job, run.instruction);
        // No field on the page: the form may be in an embedded frame.
        if (outcome.noForm) {
          outcome = (await deps.applyInFrame(tabId, job, run.instruction)) || await deps.fill(tabId, job, run.instruction, { force: true });
        }
        if (outcome.navigated) {
          lastStep = "Part of the application was filled in, and the page moved on.";
          continue;
        }
        if (outcome.newTab) return followTab(run, tabId, outcome.newTab, job);
        return outcome;
      }

      case "job_list":
      case "job_detail": {
        if (!reading.showsRequestedJob) {
          return {
            submitted: false,
            notOpened: true,
            reason: reading.pageType === "job_list"
              ? `"${job.title.slice(0, 60)}" did not open; the page still shows the list`
              : `This page shows a different job: ${reading.shownJob.title || reading.summary}`,
          };
        }
        if (reading.alreadyApplied) {
          return { submitted: false, alreadyApplied: true, applicationStatus: APPLICATION_STATUS.NOT_SUBMITTED, reason: "Already applied to this job before" };
        }
        if (!reading.applyTarget) {
          // A careers page often embeds its application in a frame, out of
          // this document's sight.
          const framed = await deps.applyInFrame(tabId, job, run.instruction);
          if (framed) return framed;
          return { submitted: false, reason: `No way to apply on this page: ${reading.summary}` };
        }

        report(run, tabId, { phase: "apply", job: job.title, note: "Starting the application" });
        const moved = await click(run, tabId, reading.applyTarget);
        if (moved.openedTab) return followTab(run, tabId, moved.openedTab, job);
        if (moved.failed) {
          failures++;
          if (failures >= LIMITS.applyFailures) {
            return { submitted: false, reason: "The apply control did not respond" };
          }
          lastStep = `Clicked ${reading.applyTarget} to apply, and the page did not react (${moved.error || "no change"}).`;
          continue;
        }
        lastStep = `Clicked ${reading.applyTarget} to apply.`;
        continue;
      }

      default: {
        // "other": neither a job nor its application. Try one step toward it.
        if (reading.towardGoalTarget && wander < LIMITS.wander) {
          wander++;
          const moved = await click(run, tabId, reading.towardGoalTarget);
          if (moved.openedTab) return followTab(run, tabId, moved.openedTab, job);
          lastStep = `Clicked ${reading.towardGoalTarget} to get closer to the application.`;
          continue;
        }
        return { submitted: false, reason: reading.summary };
      }
    }
  }
  return { submitted: false, reason: `Gave up on this job after ${LIMITS.stepsPerJob} steps` };
}

/**
 * The job moved to another tab. Work it there, then close that tab and come
 * back — unless it now needs the user, who needs to see it.
 */
async function followTab(run, fromTabId, tab, job) {
  const { deps } = run;
  report(run, tab.id, { phase: "external", job: job.title, note: "Continuing in the new tab" });
  await deps.focusTab(tab.id);
  await deps.waitForLoad(tab.id);
  const outcome = await applyToJob(run, tab.id, job);
  if (!holdsTab(outcome)) {
    await deps.closeTab(tab.id);
    await deps.focusTab(fromTabId);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Reading and acting
// ---------------------------------------------------------------------------

/**
 * Read the page in `tabId`, waiting out a page that is still loading.
 *
 * Returns `{ view, reading }`, or `{ end }` when the run cannot go on here: a
 * security wall, a sign-in, a page that never loads or cannot be read.
 */
async function look(run, tabId, ctx) {
  const { deps } = run;
  for (let wait = 0; ; wait++) {
    const view = await deps.view(tabId);
    if (!view) {
      if (wait < LIMITS.loadingWaits) {
        await deps.waitForLoad(tabId);
        await deps.sleep(TIMING.loadingWait);
        continue;
      }
      return { end: { submitted: false, reason: "The page could not be read" } };
    }
    // Checked in code, before any model sees the page. Never bypassed.
    if (view.blocked) return { end: { submitted: false, blocked: true, stopped: true, reason: view.blocked } };

    let reading;
    try {
      reading = await deps.read(tabId, view, { instruction: run.instruction, job: ctx.job || null, lastStep: ctx.lastStep || "" });
    } catch (err) {
      return { end: { submitted: false, stopped: true, reason: `Could not read the page: ${String(err?.message || err)}` } };
    }

    if (reading.pageType === "loading") {
      if (wait < LIMITS.loadingWaits) {
        await deps.sleep(TIMING.loadingWait);
        continue;
      }
      return { end: { submitted: false, reason: "The page did not finish loading" } };
    }
    if (reading.pageType === "login_required" || reading.pageType === "blocked") {
      return { end: { submitted: false, blocked: true, stopped: true, reason: reading.summary } };
    }
    return { view, reading };
  }
}

/**
 * Click an element the reading named, and say what became of it.
 * @returns {Promise<{openedTab?: object, navigated?: boolean, failed?: boolean, error?: string}>}
 */
async function click(run, tabId, target) {
  const { deps } = run;
  const r = await deps.act(tabId, { action: "click", target });
  if (r.openedTab) return { openedTab: r.openedTab };
  if (r.navigated) {
    await deps.waitForLoad(tabId);
    return { navigated: true };
  }
  if (INEFFECTIVE.has(r.result)) return { failed: true, error: r.error || null };
  await deps.sleep(TIMING.afterClick);
  return {};
}

/** Return the tab to the results list after a job took it elsewhere. */
async function backToList(run, tabId, listUrl) {
  const { deps } = run;
  if (await deps.tabUrl(tabId) === listUrl) return;
  report(run, tabId, { phase: "navigate", note: "Back to the results" });
  if (await deps.goBack(tabId)) {
    await deps.waitForLoad(tabId);
    if (await deps.tabUrl(tabId) === listUrl) return;
  }
  await deps.navigate(tabId, listUrl);
  await deps.waitForLoad(tabId);
}

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

/** A job from the reading, joined with what the page knows about its link. */
function withLink(job, link = {}) {
  return {
    ...job,
    url: link.url || "",
    newTab: Boolean(link.newTab),
    text: link.text || "",
    key: link.key || `${job.title}|${job.company}`.toLowerCase(),
  };
}

function done(run) {
  return run.applied.length + run.skipped.length;
}

/**
 * A security wall, a question for the user, or a stop: the run ends, and the
 * tab it happened in stays open and in front, where the user can act on it.
 */
function holdsTab(outcome) {
  return Boolean(outcome.blocked || outcome.stopped || outcome.waitingForUser);
}

function endFlags(outcome) {
  if (outcome.blocked) return { blocked: true };
  if (outcome.waitingForUser) return { waitingForUser: true, question: outcome.question };
  return {};
}

function record(run, tabId, job, outcome) {
  const entry = {
    title: job.title,
    company: job.company || "",
    url: job.url || "",
    applicationStatus: outcome.applicationStatus || APPLICATION_STATUS.UNKNOWN,
    reason: outcome.reason || outcome.question || null,
  };
  if (outcome.submitted) {
    run.applied.push(entry);
    run.deps.record(entry);
    report(run, tabId, { phase: "applied", job: entry.title, note: `Applied to "${String(entry.title).slice(0, 40)}"` });
  } else {
    run.skipped.push(entry);
    report(run, tabId, { phase: "skip", job: entry.title, note: entry.reason || "not submitted" });
  }
}

function report(run, tabId, event) {
  try { run.deps.report({ ...event, tabId }); } catch (_) { /* progress is cosmetic */ }
}

function summarize(run, reason, extra = {}) {
  report(run, null, { phase: "done", note: `${run.applied.length} applied, ${run.skipped.length} skipped` });
  return {
    ok: true,
    applied: run.applied,
    skipped: run.skipped,
    appliedCount: run.applied.length,
    skippedCount: run.skipped.length,
    reason,
    ...extra,
  };
}
