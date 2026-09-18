// Tests for the takeover driver — the run, as the worker drives it.
//
// The browser is a small fake: tabs holding pages, each page with the reading
// the model would give it and what each of its elements does when clicked.
// That is enough to pin down what the driver does with a reading, which is
// the part that used to go wrong: on a search results page every job read as
// "open" the moment it was clicked, and the agent went looking for Apply on
// the list itself — reporting "No control that starts an application was
// found", clicking a promotion that took the tab away, or taking a job
// applied to earlier for this one.
//
// Run with: node --test tests/takeover-driver.test.js

import test from "node:test";
import assert from "node:assert/strict";

import { runTakeover } from "../src/lib/takeover-driver.js";
import { validateReading } from "../src/lib/page-agent.js";

const CONFIRMED = "ACTION_CONFIRMED";
const NO_EFFECT = "ACTION_NO_EFFECT";

/**
 * A fake browser.
 *
 * pages: { name: { url, elements: [ids], read(ctx) -> raw reading,
 *                  clicks: { id: effect }, links: { id: link }, fill: outcome | (ctx) => outcome,
 *                  verified, blocked } }
 * effect: { navigate: page } | { openTab: page } | { change: page } | { nothing: true }
 */
function browser(pages, { start = "list", evaluate, applyInFrame, stopAfterClicks } = {}) {
  const tabs = new Map([[1, { page: start, history: [] }]]);
  let nextTab = 2;
  const log = { clicks: [], reads: [], opened: [], closed: [], focused: [], applied: [], fills: [], reports: [], evaluated: [] };
  let stopped = false;
  const byUrl = (url) => Object.keys(pages).find((name) => pages[name].url === url);
  const pageOf = (tabId) => pages[tabs.get(tabId)?.page];
  const go = (tabId, name) => {
    const tab = tabs.get(tabId);
    tab.history.push(tab.page);
    tab.page = name;
  };
  const open = (name) => {
    const id = nextTab++;
    tabs.set(id, { page: name, history: [] });
    return { id, url: pages[name].url };
  };

  const deps = {
    async view(tabId) {
      const page = pageOf(tabId);
      if (!page) return null;
      return {
        url: page.url,
        title: page.title || page.url,
        headings: [],
        text: "",
        elements: (page.elements || []).map((id) => ({ id, tag: "a", text: id })),
        blocked: page.blocked || null,
      };
    },
    async read(tabId, view, ctx) {
      const name = tabs.get(tabId).page;
      log.reads.push({ tabId, page: name, job: ctx.job?.title || null, instruction: ctx.instruction });
      return validateReading(pages[name].read(ctx), view);
    },
    async act(tabId, action) {
      const name = tabs.get(tabId).page;
      log.clicks.push({ tabId, page: name, target: action.target });
      if (stopAfterClicks && log.clicks.length >= stopAfterClicks) stopped = true;
      const effect = pages[name].clicks?.[action.target] || { nothing: true };
      if (effect.navigate) { go(tabId, effect.navigate); return { result: CONFIRMED, navigated: true }; }
      if (effect.openTab) { const tab = open(effect.openTab); log.opened.push(tab); return { result: CONFIRMED, openedTab: tab }; }
      if (effect.change) { tabs.get(tabId).page = effect.change; return { result: CONFIRMED }; }
      return { result: NO_EFFECT, error: "no observable change" };
    },
    async fill(tabId, job, instruction) {
      const name = tabs.get(tabId).page;
      log.fills.push({ tabId, page: name, job: job.title, instruction });
      const fill = pages[name].fill;
      const outcome = typeof fill === "function" ? fill({ tabId, go: (p) => go(tabId, p) }) : fill;
      return outcome || { submitted: false, reason: "nothing to fill" };
    },
    async verifySubmitted(tabId) { return Boolean(pageOf(tabId)?.verified); },
    async jobLinks(tabId, targets) {
      const page = pageOf(tabId);
      return targets.map((target) => ({ target, ...(page.links?.[target] || {}) }));
    },
    async evaluate(job) {
      log.evaluated.push(job.title);
      return evaluate ? evaluate(job) : { decision: "APPLY", reason: "fits" };
    },
    async openTab(fromTabId, url) {
      const name = byUrl(url);
      if (!name) return null;
      const tab = open(name);
      log.opened.push({ ...tab, byWorker: true });
      return tab;
    },
    async closeTab(tabId) { log.closed.push(tabId); tabs.delete(tabId); },
    async focusTab(tabId) { log.focused.push(tabId); },
    async waitForLoad() {},
    async tabUrl(tabId) { return pageOf(tabId)?.url || null; },
    async goBack(tabId) {
      const tab = tabs.get(tabId);
      if (!tab.history.length) return false;
      tab.page = tab.history.pop();
      return true;
    },
    async navigate(tabId, url) { go(tabId, byUrl(url)); },
    async applyInFrame(tabId, job) { return applyInFrame ? applyInFrame(tabId, job) : null; },
    report(event) { log.reports.push(event); },
    record(entry) { log.applied.push(entry.title); },
    control: { stopped: () => stopped, waitIfPaused: async () => {} },
    sleep: async () => {},
  };
  return { deps, log, tabs };
}

// ---------------------------------------------------------------------------
// Pages, as the model would read them
// ---------------------------------------------------------------------------

const JOBS = [
  { target: "element_1", title: "Python Developer", company: "Billions United" },
  { target: "element_2", title: "Senior Python Developer", company: "Acme" },
];

/** A results list; `extra` overrides fields of the reading. */
function list(extra = {}, fields = {}) {
  return {
    url: "https://board.test/python-developer-jobs",
    elements: ["element_1", "element_2", "element_3", "element_4"],
    read: () => ({ pageType: "job_list", summary: "Search results", jobs: JOBS, nextPageTarget: "", ...extra }),
    ...fields,
  };
}

/** One job's page, with an Apply that opens its application form in place. */
function jobPage(title, url, fields = {}) {
  return {
    url,
    elements: ["element_10"],
    read: (ctx) => ({
      pageType: "job_detail",
      summary: `Job: ${title}`,
      shownJob: { title, company: "" },
      showsRequestedJob: !ctx.job || ctx.job.title === title,
      applyTarget: "element_10",
    }),
    clicks: { element_10: { change: `form:${title}` } },
    ...fields,
  };
}

function formPage(outcome = { submitted: true, applicationStatus: "APPLICATION_SUBMITTED", reason: "Application submitted" }) {
  return {
    url: "https://board.test/apply",
    elements: ["element_20"],
    read: () => ({ pageType: "application_form", summary: "Application form" }),
    fill: outcome,
  };
}

/** A board whose job links open in a new tab, each job applying in place. */
function newTabBoard(overrides = {}) {
  return {
    list: list({}, {
      links: {
        element_1: { url: "https://board.test/job-1", newTab: true, key: "https://board.test/job-1" },
        element_2: { url: "https://board.test/job-2", newTab: true, key: "https://board.test/job-2" },
      },
    }),
    job1: jobPage("Python Developer", "https://board.test/job-1"),
    job2: jobPage("Senior Python Developer", "https://board.test/job-2"),
    "form:Python Developer": formPage(),
    "form:Senior Python Developer": formPage(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

test("each job opens in its own tab, is applied to there, and the tab is closed after", async () => {
  const { deps, log } = browser(newTabBoard());
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.equal(summary.appliedCount, 2);
  assert.deepEqual(log.applied, ["Python Developer", "Senior Python Developer"]);
  assert.deepEqual(log.opened.map((t) => t.url), ["https://board.test/job-1", "https://board.test/job-2"]);
  assert.deepEqual(log.closed, [2, 3], "the agent closes the tabs it opened");
  assert.ok(log.focused.includes(1), "and brings the results back in front");
});

test("the agent never looks for Apply on the results list when a job did not open", async () => {
  // The reported failure. The click on the job changed nothing, the page was
  // still the list — and the agent looked for Apply on the list, found
  // nothing, and skipped with "No control that starts an application".
  const pages = newTabBoard({
    list: list({}, {
      // The link does not say it opens a new tab; its click does nothing.
      links: {
        element_1: { url: "https://board.test/job-1", key: "https://board.test/job-1" },
        element_2: { url: "https://board.test/job-2", key: "https://board.test/job-2" },
      },
    }),
  });
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.equal(summary.appliedCount, 2, "each job is opened at its own address instead");
  const onList = log.clicks.filter((c) => c.page === "list").map((c) => c.target);
  assert.deepEqual(onList, ["element_1", "element_2"], "only the jobs themselves are clicked on the list");
  assert.equal(log.fills.filter((f) => f.page === "list").length, 0, "no form is filled on the list");
});

test("a click the list acknowledges, but that shows no job, is not taken for the job opening", async () => {
  // The list changed a little — a visited style, a tracking pixel — and
  // still shows the list. The reading says so, and the job is opened by
  // its address.
  const pages = newTabBoard({
    list: list({}, {
      clicks: { element_1: { change: "list" }, element_2: { change: "list" } },
      links: {
        element_1: { url: "https://board.test/job-1", key: "k1" },
        element_2: { url: "https://board.test/job-2", key: "k2" },
      },
    }),
  });
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.equal(summary.appliedCount, 2);
  assert.ok(log.reads.some((r) => r.page === "list" && r.job === "Python Developer"),
    "after the click the page was read again, with the job named");
  assert.ok(!log.clicks.some((c) => c.page === "list" && c.target === "element_3"),
    "nothing else on the list is clicked in the job's place");
});

test("a job applied to earlier is reported as such, and not counted again", async () => {
  const pages = newTabBoard();
  pages.job1 = { ...pages.job1, read: () => ({
    pageType: "job_detail", showsRequestedJob: true, alreadyApplied: true,
    shownJob: { title: "Python Developer", company: "" }, applyTarget: "",
  }) };
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.deepEqual(log.applied, ["Senior Python Developer"]);
  assert.match(summary.skipped[0].reason, /already applied/i);
});

test("a confirmation the page itself does not back up is not counted as applied", async () => {
  const pages = newTabBoard({
    "form:Python Developer": {
      url: "https://board.test/done", elements: [],
      read: () => ({ pageType: "application_submitted", summary: "Looks done" }),
      verified: false,
    },
  });
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.deepEqual(log.applied, ["Senior Python Developer"]);
  assert.match(summary.skipped[0].reason, /could not|cannot|does not say/i);
});

test("a confirmation the page backs up is counted", async () => {
  const pages = newTabBoard({
    "form:Python Developer": {
      url: "https://board.test/done", elements: [],
      read: () => ({ pageType: "application_submitted", summary: "Application submitted" }),
      verified: true,
    },
  });
  const { deps, log } = browser(pages);
  await runTakeover(deps, { tabId: 1 });
  assert.deepEqual(log.applied, ["Python Developer", "Senior Python Developer"]);
});

test("a job that replaces the list in the same tab is applied to, then the list is brought back", async () => {
  const pages = {
    list: list({}, { clicks: { element_1: { navigate: "job1" }, element_2: { navigate: "job2" } } }),
    job1: jobPage("Python Developer", "https://board.test/job-1"),
    job2: jobPage("Senior Python Developer", "https://board.test/job-2"),
    "form:Python Developer": formPage(),
    "form:Senior Python Developer": formPage(),
  };
  const { deps, log, tabs } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.equal(summary.appliedCount, 2);
  assert.equal(log.opened.length, 0, "nothing opened in another tab");
  assert.equal(tabs.get(1).page, "list", "the tab ends back on the results");
});

test("a board showing the job beside the list applies from there", async () => {
  // The list never goes away. What the reading must say is whether the
  // pane now shows THIS job.
  const pages = {
    list: list({}, { clicks: { element_1: { change: "pane1" } } }),
    pane1: {
      url: "https://board.test/python-developer-jobs", elements: ["element_1", "element_2", "element_30"],
      read: (ctx) => ({
        pageType: "job_list", jobs: JOBS, showsRequestedJob: ctx.job?.title === "Python Developer",
        shownJob: { title: "Python Developer", company: "" }, applyTarget: "element_30",
      }),
      clicks: { element_30: { change: "form:Python Developer" }, element_2: { change: "pane1" } },
    },
    "form:Python Developer": formPage(),
  };
  const { deps, log } = browser(pages, { evaluate: (job) => ({ decision: job.title === "Python Developer" ? "APPLY" : "SKIP", reason: "fit" }) });
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.deepEqual(log.applied, ["Python Developer"]);
  assert.equal(summary.appliedCount, 1);
});

test("Apply that opens the company's own site is followed there, then both tabs close", async () => {
  const pages = newTabBoard({
    job1: jobPage("Python Developer", "https://board.test/job-1", { clicks: { element_10: { openTab: "company" } } }),
    company: {
      url: "https://careers.acme.test/python", elements: ["element_40"],
      read: () => ({ pageType: "application_form", summary: "Company application" }),
      fill: { submitted: true, applicationStatus: "APPLICATION_SUBMITTED", reason: "Submitted on the company site" },
    },
  });
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.equal(summary.appliedCount, 2);
  assert.ok(log.fills.some((f) => f.page === "company"));
  assert.deepEqual(log.closed.slice(0, 2), [3, 2], "the company tab, then the job's tab");
});

test("a page that is still loading is read again rather than judged", async () => {
  let reads = 0;
  const pages = newTabBoard();
  const job1 = pages.job1;
  pages.job1 = { ...job1, read: (ctx) => (++reads < 3 ? { pageType: "loading", summary: "Loading" } : job1.read(ctx)) };
  const { deps, log } = browser(pages);
  await runTakeover(deps, { tabId: 1 });

  assert.equal(reads, 3);
  assert.ok(log.applied.includes("Python Developer"));
});

test("a CAPTCHA ends the run and leaves its tab open for the user", async () => {
  const pages = newTabBoard();
  pages.job1 = { ...pages.job1, blocked: "Bot/security verification detected." };
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.equal(summary.blocked, true);
  assert.equal(summary.appliedCount, 0);
  assert.equal(log.reads.filter((r) => r.page === "job1").length, 0, "a blocked page is never shown to the model");
  assert.ok(!log.closed.includes(2), "the tab with the challenge stays open");
});

test("a sign-in wall ends the run", async () => {
  const pages = newTabBoard();
  pages.job1 = { ...pages.job1, read: () => ({ pageType: "login_required", summary: "Sign in to apply" }) };
  const { deps } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });
  assert.equal(summary.blocked, true);
  assert.match(summary.reason, /sign in/i);
});

test("a question the agent cannot answer ends the run in the tab that asks it", async () => {
  const pages = newTabBoard({
    "form:Python Developer": formPage({ submitted: false, waitingForUser: true, question: "What is your visa status?" }),
  });
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.equal(summary.waitingForUser, true);
  assert.equal(summary.question, "What is your visa status?");
  assert.ok(!log.closed.includes(2));
});

test("jobs that do not fit are skipped without being opened", async () => {
  const { deps, log } = browser(newTabBoard(), {
    evaluate: (job) => (job.title === "Python Developer" ? { decision: "SKIP", reason: "Needs 8 years" } : { decision: "APPLY" }),
  });
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.deepEqual(log.applied, ["Senior Python Developer"]);
  assert.equal(log.opened.length, 1);
  assert.equal(summary.skipped[0].reason, "Needs 8 years");
});

test("the governor saying stop ends the run instead of skipping job after job", async () => {
  const { deps, log } = browser(newTabBoard(), { evaluate: () => ({ decision: "STOP", reason: "hourly cap reached" }) });
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.match(summary.reason, /hourly cap/);
  assert.equal(log.evaluated.length, 1);
  assert.equal(log.opened.length, 0);
});

test("without a valid profile the run stops before opening any job", async () => {
  const { deps, log } = browser(newTabBoard(), { evaluate: () => ({ error: "Complete and save a valid candidate profile first" }) });
  const summary = await runTakeover(deps, { tabId: 1 });
  assert.equal(summary.ok, false);
  assert.equal(log.opened.length, 0);
});

test("maxJobs bounds the run", async () => {
  const { deps, log } = browser(newTabBoard());
  const summary = await runTakeover(deps, { tabId: 1, maxJobs: 1 });
  assert.equal(summary.appliedCount + summary.skippedCount, 1);
  assert.equal(log.opened.length, 1);
});

test("a stop request ends the run rather than finishing the list", async () => {
  const { deps } = browser(newTabBoard(), { stopAfterClicks: 1 });
  const summary = await runTakeover(deps, { tabId: 1 });
  assert.match(summary.reason, /stopped by user/);
  assert.ok(summary.appliedCount < 2);
});

test("when a page's jobs are done, the next page of results is worked too", async () => {
  const pages = newTabBoard({
    list: list({ nextPageTarget: "element_4" }, {
      links: newTabBoard().list.links,
      clicks: { element_4: { navigate: "list2" } },
    }),
    list2: {
      url: "https://board.test/python-developer-jobs-2", elements: ["element_5"],
      read: () => ({ pageType: "job_list", jobs: [{ target: "element_5", title: "Django Developer", company: "" }] }),
      links: { element_5: { url: "https://board.test/job-3", newTab: true, key: "k3" } },
    },
    job3: jobPage("Django Developer", "https://board.test/job-3"),
    "form:Django Developer": formPage(),
  });
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1, maxPages: 2 });

  assert.deepEqual(log.applied, ["Python Developer", "Senior Python Developer", "Django Developer"]);
  assert.equal(summary.appliedCount, 3);
});

test("maxPages stops the run from turning to another page", async () => {
  const pages = newTabBoard({
    list: list({ nextPageTarget: "element_4" }, { links: newTabBoard().list.links, clicks: { element_4: { navigate: "list" } } }),
  });
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1, maxPages: 1 });
  assert.equal(summary.appliedCount, 2);
  assert.ok(!log.clicks.some((c) => c.target === "element_4"));
});

test("from a page that is neither, the agent takes a step toward the instruction", async () => {
  // A company's home page: the model points at its Careers link.
  const pages = newTabBoard({
    home: {
      url: "https://acme.test/", elements: ["element_50"],
      read: () => ({ pageType: "other", summary: "Company home page", towardGoalTarget: "element_50" }),
      clicks: { element_50: { navigate: "list" } },
    },
  });
  const { deps, log } = browser(pages, { start: "home" });
  const summary = await runTakeover(deps, { tabId: 1, instruction: "Apply to Python jobs at Acme" });

  assert.equal(summary.appliedCount, 2);
  assert.equal(log.clicks[0].target, "element_50");
  assert.ok(log.reads.every((r) => r.instruction === "Apply to Python jobs at Acme"),
    "every reading is told what the user asked for");
});

test("a page with nothing to do and nowhere to go ends the run, saying what it saw", async () => {
  const { deps } = browser({
    home: { url: "https://news.test/", elements: [], read: () => ({ pageType: "other", summary: "A news article" }) },
  }, { start: "home" });
  const summary = await runTakeover(deps, { tabId: 1 });
  assert.match(summary.reason, /A news article/);
  assert.equal(summary.appliedCount, 0);
});

test("starting on one job applies to that job", async () => {
  const pages = newTabBoard();
  const { deps, log } = browser(pages, { start: "job1" });
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.deepEqual(log.applied, ["Python Developer"]);
  assert.equal(summary.appliedCount, 1);
  assert.equal(log.evaluated.length, 0, "the user chose this job themselves");
});

test("a job page whose application is in an embedded frame is applied to there", async () => {
  const pages = newTabBoard();
  pages.job1 = { ...pages.job1, read: () => ({
    pageType: "job_detail", showsRequestedJob: true, shownJob: { title: "Python Developer", company: "" }, applyTarget: "",
  }) };
  const framed = [];
  const { deps, log } = browser(pages, {
    applyInFrame: (tabId, job) => {
      framed.push(job.title);
      return job.title === "Python Developer" ? { submitted: true, reason: "embedded form submitted" } : null;
    },
  });
  await runTakeover(deps, { tabId: 1 });

  assert.deepEqual(framed, ["Python Developer"]);
  assert.ok(log.applied.includes("Python Developer"));
});

test("an apply control that never responds skips the job after a retry", async () => {
  const pages = newTabBoard();
  pages.job1 = { ...pages.job1, clicks: {} };
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.equal(log.clicks.filter((c) => c.page === "job1").length, 2);
  assert.match(summary.skipped[0].reason, /did not respond/);
  assert.ok(log.applied.includes("Senior Python Developer"));
});

test("a job page showing a different job is not applied to", async () => {
  const pages = newTabBoard();
  pages.job1 = { ...pages.job1, read: () => ({
    pageType: "job_detail", showsRequestedJob: false, shownJob: { title: "Data Analyst", company: "" }, applyTarget: "element_10",
  }) };
  const { deps, log } = browser(pages);
  const summary = await runTakeover(deps, { tabId: 1 });

  assert.ok(!log.clicks.some((c) => c.page === "job1"));
  assert.match(summary.skipped[0].reason, /different job/);
});

test("the instruction reaches the form filler too", async () => {
  const { deps, log } = browser(newTabBoard());
  await runTakeover(deps, { tabId: 1, instruction: "Say my notice period is 30 days" });
  assert.ok(log.fills.every((f) => f.instruction === "Say my notice period is 30 days"));
});

test("the same job listed twice on a page is visited once", async () => {
  const pages = newTabBoard({
    list: list({ jobs: [JOBS[0], { ...JOBS[0], target: "element_3" }] }, {
      links: {
        element_1: { url: "https://board.test/job-1", newTab: true, key: "https://board.test/job-1" },
        element_3: { url: "https://board.test/job-1", newTab: true, key: "https://board.test/job-1" },
      },
    }),
  });
  const { deps, log } = browser(pages);
  await runTakeover(deps, { tabId: 1 });
  assert.deepEqual(log.applied, ["Python Developer"]);
});

test("a job that leaves the tab somewhere unrelated returns to the results, not onward", async () => {
  // The job opened beside the list, and its Apply led to a page that is
  // neither a job nor the list — a "recommended for you" page with a Jobs
  // link. The run must go back to the user's search, not wander off.
  const pages = {
    list: list({}, { clicks: { element_1: { change: "pane1" }, element_2: { navigate: "job2" } } }),
    pane1: {
      url: "https://board.test/python-developer-jobs", elements: ["element_1", "element_2", "element_30"],
      read: (ctx) => ({
        pageType: "job_list", jobs: JOBS, showsRequestedJob: ctx.job?.title === "Python Developer",
        shownJob: { title: "Python Developer", company: "" }, applyTarget: "element_30",
      }),
      clicks: { element_30: { navigate: "recommended" }, element_2: { navigate: "job2" } },
    },
    recommended: {
      url: "https://board.test/recommended", elements: ["element_60"],
      read: (ctx) => ({ pageType: "other", summary: "Recommended jobs", towardGoalTarget: ctx.job ? "" : "element_60" }),
    },
    job2: jobPage("Senior Python Developer", "https://board.test/job-2"),
    "form:Senior Python Developer": formPage(),
  };
  const { deps, log } = browser(pages);
  await runTakeover(deps, { tabId: 1 });

  assert.ok(!log.clicks.some((c) => c.target === "element_60"), "no step away from the results");
  assert.deepEqual(log.applied, ["Senior Python Developer"]);
  assert.equal(await deps.tabUrl(1), pages.list.url, "the tab ends on the results");
});
