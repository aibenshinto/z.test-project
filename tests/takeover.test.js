// Tests for the takeover session — the agent working the user's own tab.
//
// The behaviours that matter here are the ones that differ from the old
// background-queue model: the agent reads the results the USER searched for,
// works down them in the tab the user is watching, never opens a hidden tab,
// and stops with the page left where the user can act on it.
//
// Run with: node --test tests/takeover.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createEnvironment } from "./helpers/dom-harness.js";

const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"),
);

/** Every script Chrome injects into a page on this host, in manifest order. */
function scriptsFor(hostname) {
  const files = [];
  for (const block of MANIFEST.content_scripts) {
    const matched = block.matches.some((pattern) => {
      const m = /^https?:\/\/([^/]+)\//.exec(pattern);
      if (!m) return false;
      const host = m[1];
      if (host === "*") return true;
      if (host.startsWith("*.")) {
        const base = host.slice(2);
        return hostname === base || hostname.endsWith("." + base);
      }
      return hostname === host;
    });
    if (matched) files.push(...block.js);
  }
  return files;
}

/** A results page with `count` job cards, as a job board renders them. */
function resultsPage(hostname = "www.naukri.com", count = 3, url) {
  const e = createEnvironment({
    scripts: scriptsFor(hostname),
    url: url || `https://${hostname}/python-developer-jobs`,
  });

  const jobs = [];
  for (let i = 1; i <= count; i++) {
    const card = e.make("div", { class: "srp-jobtuple", rect: { x: 0, y: i * 140, width: 800, height: 120 } });
    const link = e.make("a", {
      href: `https://${hostname}/job-listings-python-developer-acme-${i}00000`,
      text: `Python Developer ${i}`,
      rect: { x: 10, y: i * 140, width: 300, height: 24 },
    }, card);
    e.make("span", { text: "Acme Corp", rect: { x: 10, y: i * 140 + 30, width: 200, height: 20 } }, card);
    jobs.push({ card, link });
  }
  return { e, jobs };
}

// ---------------------------------------------------------------------------
// Reading the user's own search results
// ---------------------------------------------------------------------------

test("the walker reads the jobs the user searched for, in the order shown", () => {
  const { e } = resultsPage("www.naukri.com", 3);
  const jobs = e.sandbox.__autoApplyResultsWalker.findJobs();

  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((j) => j.title), ["Python Developer 1", "Python Developer 2", "Python Developer 3"]);
  assert.equal(jobs[0].company, "Acme Corp");
});

test("the walker recognises LinkedIn job links too", () => {
  const e = createEnvironment({
    scripts: scriptsFor("www.linkedin.com"),
    url: "https://www.linkedin.com/jobs/search/?keywords=python",
  });
  for (let i = 1; i <= 2; i++) {
    const card = e.make("li", { rect: { x: 0, y: i * 120, width: 400, height: 100 } });
    e.make("a", {
      href: `https://www.linkedin.com/jobs/view/${i}000000`,
      text: `Backend Engineer ${i}`,
      rect: { x: 8, y: i * 120, width: 300, height: 22 },
    }, card);
  }

  const jobs = e.sandbox.__autoApplyResultsWalker.findJobs();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].title, "Backend Engineer 1");
});

test("non-job links on the page are not mistaken for results", () => {
  const { e } = resultsPage("www.naukri.com", 2);
  e.make("a", { href: "https://www.naukri.com/settings", text: "Settings", rect: { width: 80, height: 20 } });
  e.make("a", { href: "https://www.naukri.com/help", text: "Help", rect: { width: 80, height: 20 } });

  assert.equal(e.sandbox.__autoApplyResultsWalker.findJobs().length, 2);
});

test("the same job linked twice in one card counts once", () => {
  const { e } = resultsPage("www.naukri.com", 1);
  // A card often links to the job from both the title and a "view" affordance.
  e.make("a", {
    href: "https://www.naukri.com/job-listings-python-developer-acme-100000?src=rec",
    text: "View details",
    rect: { x: 400, y: 140, width: 100, height: 20 },
  });

  assert.equal(e.sandbox.__autoApplyResultsWalker.findJobs().length, 1);
});

test("a results page is distinguished from a single job page", () => {
  const { e } = resultsPage("www.naukri.com", 3);
  assert.equal(e.sandbox.__autoApplyTakeover.onResultsPage(), true);

  const single = createEnvironment({
    scripts: scriptsFor("www.naukri.com"),
    url: "https://www.naukri.com/job-listings-python-developer-acme-100000",
  });
  single.make("button", { id: "apply-button", text: "Apply", rect: { width: 100, height: 40 } });
  assert.equal(single.sandbox.__autoApplyTakeover.onResultsPage(), false);
});

// ---------------------------------------------------------------------------
// Adapter selection follows the page, not the run
// ---------------------------------------------------------------------------

test("one adapter reads every site, job board or company careers page", () => {
  // A run crosses sites constantly — a board's result opens the company's own
  // ATS, which opens a third-party form — and no hop needs the agent to know
  // which site it is on.
  for (const hostname of [
    "www.naukri.com", "www.linkedin.com", "in.indeed.com",
    "boards.greenhouse.io", "jobs.lever.co", "careers.acme.test",
  ]) {
    const e = createEnvironment({ scripts: scriptsFor(hostname), url: `https://${hostname}/x` });
    assert.equal(
      e.sandbox.__autoApplyTakeover.adapterForCurrentPage().name, "generic",
      `${hostname} must be readable without a bundle of its own`,
    );
  }
});

// ---------------------------------------------------------------------------
// Opening a job from the list
// ---------------------------------------------------------------------------

test("opening a job clicks the card the way a user would", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 2);

  let openedTitle = null;
  jobs[0].link.addEventListener("click", () => {
    openedTitle = "Python Developer 1";
    e.make("div", { role: "dialog", rect: { width: 600, height: 400 } });
  });

  const list = e.sandbox.__autoApplyResultsWalker.findJobs();
  const result = await e.sandbox.__autoApplyResultsWalker.openJob(
    list[0], () => openedTitle !== null, { settleMax: 200, openWaitMs: 400 });

  assert.equal(result.opened, true);
  assert.equal(openedTitle, "Python Developer 1");
});

test("a job card that does not respond is reported, not silently counted", async () => {
  const { e } = resultsPage("www.naukri.com", 1);
  const list = e.sandbox.__autoApplyResultsWalker.findJobs();

  const result = await e.sandbox.__autoApplyResultsWalker.openJob(
    list[0], () => false, { settleMax: 200, openWaitMs: 400 });

  assert.equal(result.opened, false);
  assert.match(result.reason, /did not appear/i);
});

test("a job that opens in a new tab is clicked once, not clicked again as unresponsive", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 1);

  let clicks = 0;
  jobs[0].link.addEventListener("click", () => {
    clicks++;
    e.document.visibilityState = "hidden"; // the new tab takes focus
  });
  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "TAB_OPENED_SINCE" && clicks
      ? { ok: true, opened: true, tab: { id: 42, url: "https://www.naukri.com/job-listings-x" } }
      : { ok: true };

  const walker = e.sandbox.__autoApplyResultsWalker;
  const result = await walker.openJob(walker.findJobs()[0], () => false, { settleMax: 200, openWaitMs: 400 });

  assert.equal(clicks, 1, "a retry would open the job a second time");
  assert.equal(result.opened, true);
  assert.equal(result.newTab.id, 42);
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test("a next-page control is found by its accessible name", () => {
  const { e } = resultsPage("www.naukri.com", 2);
  e.make("button", { text: "Next", rect: { x: 400, y: 900, width: 80, height: 36 } });

  assert.ok(e.sandbox.__autoApplyResultsWalker.findNextPage());
});

test("an unrelated Next button inside a form is not treated as pagination", () => {
  const { e } = resultsPage("www.naukri.com", 2);
  e.make("button", { "aria-label": "Next step in application", rect: { width: 120, height: 36 } });

  // "Next step in application" is not a bare pagination control.
  const next = e.sandbox.__autoApplyResultsWalker.findNextPage();
  assert.equal(next, null);
});

// ---------------------------------------------------------------------------
// The visible cursor
// ---------------------------------------------------------------------------

test("the cursor overlay never intercepts clicks meant for the page", async () => {
  const { e } = resultsPage("www.naukri.com", 1);
  await e.sandbox.__autoApplyCursor.moveTo(100, 100);

  const root = e.document.querySelector("#__aa_cursor_root__");
  assert.ok(root, "the overlay must exist once used");
  // pointer-events:none is what keeps it from stealing clicks.
  assert.match(
    e.document.querySelector("#__aa_cursor_style__").textContent,
    /pointer-events:\s*none/,
  );
});

test("the cursor can be turned off and leaves no overlay behind", () => {
  const { e } = resultsPage("www.naukri.com", 1);
  e.sandbox.__autoApplyCursor.setEnabled(false);
  assert.equal(e.sandbox.__autoApplyCursor.isEnabled(), false);

  e.sandbox.__autoApplyCursor.destroy();
  assert.equal(e.document.querySelector("#__aa_cursor_root__"), null);
});

test("a broken cursor overlay never breaks an interaction", async () => {
  const { e } = resultsPage("www.naukri.com", 1);
  const btn = e.make("button", { text: "Easy Apply", rect: { x: 0, y: 0, width: 120, height: 40 } });
  btn.addEventListener("click", () => e.make("div", { role: "dialog", rect: { width: 300, height: 200 } }));

  // Simulate the overlay throwing on every call.
  e.sandbox.__autoApplyCursor.moveTo = () => { throw new Error("overlay exploded"); };
  e.sandbox.__autoApplyCursor.flashClick = () => { throw new Error("overlay exploded"); };

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements
    .find((x) => x.text === "Easy Apply").id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 400 });

  assert.equal(result.result, "ACTION_CONFIRMED", "the click must succeed despite the overlay failing");
});

// ---------------------------------------------------------------------------
// Run control
// ---------------------------------------------------------------------------

test("the takeover exposes run controls to the side panel", () => {
  const { e } = resultsPage("www.naukri.com", 1);
  const t = e.sandbox.__autoApplyTakeover;

  for (const fn of ["run", "stop", "pause", "resume", "isRunning", "reset"]) {
    assert.equal(typeof t[fn], "function", `${fn} must be available`);
  }
  assert.equal(t.isRunning(), false);
});

test("the agent never opens or closes tabs from the content script", () => {
  // Tab control belongs to the worker, which validates it. A content script
  // that could open tabs would let a page-level bug spawn windows.
  const source = readFileSync(
    fileURLToPath(new URL("../src/content/shared/takeover.js", import.meta.url)), "utf8",
  );
  assert.ok(!/chrome\.tabs\./.test(source), "takeover.js must not call chrome.tabs directly");
  assert.ok(!/window\.open\(/.test(source), "takeover.js must not call window.open");
});

/**
 * Wire a results page so clicking a job shows a detail view with an Apply
 * button, and going back restores the list — the shape of a real job board.
 */
function wireJobFlow(e, jobs, { applyOpensForm = true } = {}) {
  // Collapse the human-paced waits: these tests assert sequencing, not pacing,
  // and the production defaults would make the suite take minutes.
  e.sandbox.__autoApplyTakeover.configure({
    settleMax: 200, afterOpen: 50, betweenJobs: 20, afterPage: 50,
    backAttempts: 1, backWait: 50, openWaitMs: 400, applyBudgetMs: 1500,
  });

  const restore = () => {
    for (const { card } of jobs) if (!card.isConnected) e.document.body.appendChild(card);
    for (const el of e.document.body.querySelectorAll(".aa-detail")) el.remove();
  };
  e.sandbox.__onHistoryBack = restore;

  for (const { link } of jobs) {
    link.addEventListener("click", () => {
      for (const { card } of jobs) card.remove();
      const detail = e.make("div", { class: "aa-detail", rect: { x: 0, y: 0, width: 800, height: 600 } });
      const apply = e.make("button", {
        id: "apply-button", text: "Apply", rect: { x: 100, y: 200, width: 120, height: 40 },
      }, detail);
      if (applyOpensForm) {
        apply.addEventListener("click", () => {
          e.make("div", { class: "singleselect-radiobutton", rect: { x: 0, y: 300, width: 600, height: 200 } }, detail);
          e.make("h1", { text: "Application submitted", rect: { x: 0, y: 520, width: 400, height: 30 } }, detail);
        });
      }
    });
  }
}

test("the agent works down the whole list the user searched for", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 3);
  wireJobFlow(e, jobs);

  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "AI_DECIDE_ACTION" ? { ok: true, action: { action: "finish" } } : { ok: true, adopted: false, decision: "APPLY" };

  const result = await e.sandbox.__autoApplyTakeover.run({ maxJobs: 3, maxPages: 1 });

  assert.equal(result.appliedCount, 3, "every visible job should be applied to");
  assert.deepEqual(
    result.applied.map((j) => j.title),
    ["Python Developer 1", "Python Developer 2", "Python Developer 3"],
  );
});

test("the run reports progress the side panel can show while it works", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 2);
  wireJobFlow(e, jobs);

  const phases = [];
  e.sandbox.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === "TAKEOVER_PROGRESS") phases.push(msg.phase);
    if (msg.type === "AI_DECIDE_ACTION") return { ok: true, action: { action: "finish" } };
    return { ok: true, adopted: false, decision: "APPLY" };
  };

  await e.sandbox.__autoApplyTakeover.run({ maxJobs: 2, maxPages: 1 });

  for (const phase of ["start", "open", "apply", "form", "applied", "done"]) {
    assert.ok(phases.includes(phase), `progress should report the "${phase}" phase`);
  }
});

test("a job whose apply button does nothing is skipped, not counted as applied", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 2);
  wireJobFlow(e, jobs, { applyOpensForm: false });

  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "AI_DECIDE_ACTION" ? { ok: true, action: { action: "stop", reason: "no form" } } : { ok: true, adopted: false, decision: "APPLY" };

  const result = await e.sandbox.__autoApplyTakeover.run({ maxJobs: 2, maxPages: 1 });

  assert.equal(result.appliedCount, 0, "an unresponsive apply button must never count as applied");
  assert.ok(result.skippedCount >= 1);
});

test("maxJobs bounds the run", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 5);
  wireJobFlow(e, jobs);

  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "AI_DECIDE_ACTION" ? { ok: true, action: { action: "finish" } } : { ok: true, adopted: false, decision: "APPLY" };

  const result = await e.sandbox.__autoApplyTakeover.run({ maxJobs: 2, maxPages: 1 });
  assert.equal(result.appliedCount + result.skippedCount, 2);
});

test("a CAPTCHA mid-run stops everything and leaves the page for the user", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 3);
  wireJobFlow(e, jobs);

  // The second job triggers a challenge.
  let opened = 0;
  for (const { link } of jobs) {
    link.addEventListener("click", () => {
      if (++opened === 2) {
        e.make("iframe", {
          src: "https://www.google.com/recaptcha/api2/bframe?k=x",
          rect: { x: 0, y: 0, width: 300, height: 400 },
        });
      }
    });
  }

  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "AI_DECIDE_ACTION" ? { ok: true, action: { action: "finish" } } : { ok: true, adopted: false, decision: "APPLY" };

  const result = await e.sandbox.__autoApplyTakeover.run({ maxJobs: 3, maxPages: 1 });

  assert.equal(result.blocked, true, "a challenge must stop the whole run");
  assert.match(result.reason, /captcha|challenge|security/i);
  assert.ok(result.appliedCount < 3, "the run must not continue past a challenge");
});

test("a stop request ends the run rather than finishing the list", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 3);
  const t = e.sandbox.__autoApplyTakeover;
  t.configure({ settleMax: 200, afterOpen: 50, betweenJobs: 20, afterPage: 50, backAttempts: 1, backWait: 50, openWaitMs: 400, applyBudgetMs: 1500 });

  // Every card opens a dialog, so jobs would otherwise keep being processed.
  for (const { link } of jobs) {
    link.addEventListener("click", () => {
      e.make("div", { role: "dialog", rect: { width: 600, height: 400 } });
      t.stop(); // the user presses Stop during the first job
    });
  }

  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "AI_DECIDE_ACTION"
      ? { ok: true, action: { action: "stop", reason: "test" } }
      : { ok: true, adopted: false, decision: "APPLY" };

  const result = await t.run({ maxJobs: 3, maxPages: 1 });

  assert.equal(result.ok, true);
  assert.ok(result.appliedCount + result.skippedCount < 3, "the run must not process every job after Stop");
});

// ---------------------------------------------------------------------------
// Jobs that open in a new tab
// ---------------------------------------------------------------------------

/**
 * Wire a results page where every job opens in a new tab, as Naukri's do.
 * The worker follows each tab and reports `adoptResult` for it.
 */
function wireNewTabJobs(e, jobs, adoptResult) {
  e.sandbox.__autoApplyTakeover.configure({
    settleMax: 200, afterOpen: 50, betweenJobs: 20, afterPage: 50,
    backAttempts: 1, backWait: 50, openWaitMs: 400, applyBudgetMs: 1500,
  });

  let nextTabId = 100;
  let opened = null;
  for (const { link } of jobs) {
    link.addEventListener("click", () => {
      e.document.visibilityState = "hidden";
      opened = { id: nextTabId++, url: link.getAttribute("href") };
    });
  }

  const followed = [];
  e.sandbox.chrome.runtime.sendMessage = async (msg) => {
    switch (msg.type) {
      case "TAB_OPENED_SINCE":
        return opened ? { ok: true, opened: true, tab: opened } : { ok: true, opened: false };
      case "TAKEOVER_ADOPT_NEW_TAB":
        if (msg.tabId == null) return { ok: true, adopted: false, decision: "APPLY" };
        followed.push(msg.tabId);
        opened = null;
        e.document.visibilityState = "visible"; // the worker refocuses the results
        return { ok: true, adopted: true, result: adoptResult };
      case "TAKEOVER_EVALUATE_JOB":
        return { ok: true, decision: "APPLY" };
      default:
        return { ok: true };
    }
  };
  return followed;
}

test("the run follows each job into the tab it opens, without the user taking over again", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 2);
  const followed = wireNewTabJobs(e, jobs, {
    submitted: true, applicationStatus: "APPLICATION_SUBMITTED",
  });

  const result = await e.sandbox.__autoApplyTakeover.run({ maxJobs: 2, maxPages: 1 });

  assert.deepEqual(followed, [100, 101], "each job's new tab must be followed, once");
  assert.equal(result.appliedCount, 2);
});

test("a question in a followed tab ends the run, leaving that tab to the user", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 2);
  const followed = wireNewTabJobs(e, jobs, {
    submitted: false, waitingForUser: true, question: "What is your notice period?",
  });

  const result = await e.sandbox.__autoApplyTakeover.run({ maxJobs: 2, maxPages: 1 });

  assert.deepEqual(followed, [100], "the run must not move on to the next job");
  assert.equal(result.waitingForUser, true);
  assert.equal(result.question, "What is your notice period?");
});

// ---------------------------------------------------------------------------
// Only jobs that fit the profile
// ---------------------------------------------------------------------------

test("a job that does not fit the profile is skipped without being opened", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 2);
  const followed = wireNewTabJobs(e, jobs, { submitted: true, applicationStatus: "APPLICATION_SUBMITTED" });

  const evaluated = [];
  const worker = e.sandbox.chrome.runtime.sendMessage;
  e.sandbox.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type !== "TAKEOVER_EVALUATE_JOB") return worker(msg);
    evaluated.push(msg.job);
    return msg.job.title === "Python Developer 1"
      ? { ok: true, decision: "SKIP", reason: "Does not match your profile (20% match)" }
      : { ok: true, decision: "APPLY", reason: "Matches your profile (80% match)" };
  };

  const result = await e.sandbox.__autoApplyTakeover.run({ maxJobs: 2, maxPages: 1 });

  assert.match(evaluated[0].text, /Acme Corp/, "the card's text must reach the evaluator");
  assert.equal(followed.length, 1, "only the matching job may be opened");
  assert.deepEqual(result.applied.map((j) => j.title), ["Python Developer 2"]);
  assert.match(result.skipped[0].reason, /does not match your profile/i);
});

test("without a valid profile the run stops before opening any job", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 2);
  const followed = wireNewTabJobs(e, jobs, { submitted: true });
  const worker = e.sandbox.chrome.runtime.sendMessage;
  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "TAKEOVER_EVALUATE_JOB"
      ? { ok: false, error: "Complete and save a valid candidate profile first" }
      : worker(msg);

  const result = await e.sandbox.__autoApplyTakeover.run({ maxJobs: 2, maxPages: 1 });

  assert.equal(result.ok, false);
  assert.match(result.error, /profile/);
  assert.deepEqual(followed, []);
});

// ---------------------------------------------------------------------------
// Opening jobs without tripping the pop-up blocker
// ---------------------------------------------------------------------------

test("a job link that opens in a new tab is opened by the worker, not by a scripted click", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 1);
  jobs[0].link.setAttribute("target", "_blank");
  let clicks = 0;
  jobs[0].link.addEventListener("click", () => clicks++);

  const requests = [];
  e.sandbox.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type !== "OPEN_TAB_FROM_PAGE") return { ok: true };
    requests.push(msg.url);
    return { ok: true, tab: { id: 9, url: msg.url } };
  };

  const walker = e.sandbox.__autoApplyResultsWalker;
  const result = await walker.openJob(walker.findJobs()[0], () => false, { settleMax: 200, openWaitMs: 400 });

  assert.equal(clicks, 0, "Chrome blocks a scripted target=_blank click as a pop-up");
  assert.deepEqual(requests, ["https://www.naukri.com/job-listings-python-developer-acme-100000"]);
  assert.equal(result.newTab.id, 9);
});

// ---------------------------------------------------------------------------
// Company careers pages that list many jobs
// ---------------------------------------------------------------------------

/** A careers page table: one row per opening, each with its own Apply link. */
function careersPage(titles) {
  const e = createEnvironment({
    scripts: scriptsFor("knowledgesprint.test"),
    url: "https://knowledgesprint.test/careers",
    title: "Careers",
  });
  e.sandbox.__autoApplyTakeover.configure({ settleMax: 200, openWaitMs: 300, applyBudgetMs: 1500 });
  const clicked = [];
  titles.forEach((title, i) => {
    const row = e.make("tr", { rect: { x: 0, y: 100 + i * 80, width: 1000, height: 70 } });
    e.make("td", { text: title, rect: { x: 0, y: 100 + i * 80, width: 300, height: 70 } }, row);
    const apply = e.make("a", { href: `https://knowledgesprint.test/apply/${i}`, text: "Apply", rect: { x: 900, y: 120 + i * 80, width: 60, height: 20 } }, row);
    apply.addEventListener("click", () => clicked.push(title));
  });
  return { e, clicked };
}

test("on a careers page listing many jobs, the agent clicks this job's own Apply", async () => {
  const { e, clicked } = careersPage(["Intern - HR Executive", "Intern - Linux System Engineer", "Python Developer - AI Assisted Development"]);
  e.sandbox.chrome.runtime.sendMessage = async () => ({ ok: true });

  await e.sandbox.__autoApplyTakeover.applyToOpenJob({ title: "Python Developer - AI Assisted Development", company: "Knowledgesprint" });

  // The test page does not react, so the click is retried; every retry must
  // still land on this job's row, never a neighbour's.
  assert.ok(clicked.length >= 1);
  assert.deepEqual([...new Set(clicked)], ["Python Developer - AI Assisted Development"]);
});

test("a careers page that does not list this job is skipped without clicking any Apply", async () => {
  const { e, clicked } = careersPage(["Intern - HR Executive", "Intern - AWS Cloud Engineer"]);
  e.sandbox.chrome.runtime.sendMessage = async () => ({ ok: true });

  const result = await e.sandbox.__autoApplyTakeover.applyToOpenJob({ title: "Python Developer", company: "Knowledgesprint" });

  assert.deepEqual(clicked, [], "applying for a different job is worse than not applying");
  assert.equal(result.submitted, false);
  assert.match(result.reason, /lists several jobs, but not "Python Developer"/);
});

// ---------------------------------------------------------------------------
// Boards the agent has never seen
// ---------------------------------------------------------------------------

/** A results page whose job links follow `hrefFor`, as an unknown board would. */
function listingPage(url, hrefFor, count = 5, titleFor = (i) => `Senior Python Developer ${i}`) {
  const e = createEnvironment({ scripts: scriptsFor(new URL(url).hostname), url });
  e.make("a", { href: "/about", text: "About us", rect: { x: 0, y: 0, width: 80, height: 20 } });
  e.make("a", { href: "/engineering", text: "Engineering", rect: { x: 90, y: 0, width: 100, height: 20 } });

  for (let i = 1; i <= count; i++) {
    const card = e.make("div", { rect: { x: 0, y: i * 120, width: 800, height: 100 } });
    e.make("a", {
      href: hrefFor(i),
      text: titleFor(i),
      rect: { x: 10, y: i * 120, width: 320, height: 24 },
    }, card);
    e.make("span", { text: "Acme Corp", rect: { x: 10, y: i * 120 + 30, width: 200, height: 20 } }, card);
  }
  return e;
}

test("a board with URLs nobody listed is still read, by the shape its list repeats", () => {
  // Greenhouse, Lever, Workday, Glassdoor and SmartRecruiters all missed the
  // old list of known URL patterns. On those the walker found no jobs at all,
  // and the run treated the whole search page as a single job.
  const boards = [
    ["https://boards.greenhouse.io/acme?t=1", (i) => `https://boards.greenhouse.io/acme/jobs/40123${i}`],
    ["https://jobs.lever.co/acme", (i) => `https://jobs.lever.co/acme/2f1b8c44-1f0a-4a1e-9f1a-2b3c4d5e6f7${i}`],
    ["https://acme.wd1.myworkdayjobs.com/careers", (i) => `https://acme.wd1.myworkdayjobs.com/careers/job/Bengaluru/Python-Dev_R-1234${i}`],
    ["https://www.glassdoor.co.in/Job/index.htm", (i) => `https://www.glassdoor.co.in/partner/jobListing.htm?jobListingId=100912345${i}`],
    ["https://jobs.smartrecruiters.com/Acme", (i) => `https://jobs.smartrecruiters.com/Acme/74399991234${i}-python-developer`],
  ];

  for (const [url, hrefFor] of boards) {
    const jobs = listingPage(url, hrefFor).sandbox.__autoApplyResultsWalker.findJobs();
    assert.equal(jobs.length, 5, `${url} should yield 5 jobs`);
    assert.match(jobs[0].title, /Senior Python Developer/);
  }
});

test("a menu of same-shaped links is not a list of jobs", () => {
  // The guard on the above: a row of links sharing a URL shape is a menu or a
  // breadcrumb. A list of results stacks down the page instead.
  const e = createEnvironment({ scripts: scriptsFor("acme.test"), url: "https://acme.test/careers" });
  for (let i = 1; i <= 5; i++) {
    e.make("a", {
      href: `https://acme.test/team/1234${i}`,
      text: `Our team in city ${i}`,
      rect: { x: i * 150, y: 0, width: 140, height: 24 },
    });
  }

  assert.equal(e.sandbox.__autoApplyResultsWalker.findJobs().length, 0);
});

test("a job's own page is not a results list, however many other jobs it rails", () => {
  // A job page carries "similar jobs". Walking that rail means applying to
  // every job except the one the user opened.
  const e = listingPage("https://in.indeed.com/viewjob?jk=abc123",
    (i) => `https://in.indeed.com/viewjob?jk=other${i}`);

  assert.ok(e.sandbox.__autoApplyResultsWalker.findJobs().length >= 3, "the rail is still readable");
  assert.equal(e.sandbox.__autoApplyTakeover.onResultsPage(), false);
});

test("a search page is a results list even when its URL names one job", () => {
  // A board that shows the detail in a pane puts the open job in the URL.
  const e = listingPage("https://www.linkedin.com/jobs/search/?keywords=python&currentJobId=4012345678",
    (i) => `https://www.linkedin.com/jobs/view/401234567${i}`);

  assert.equal(e.sandbox.__autoApplyTakeover.onResultsPage(), true);
});

test("the next page is only reached when the results actually change", async () => {
  // A pager that quietly does nothing, or a "Next" in a carousel, would
  // otherwise have the run walk the same jobs over again.
  const { e } = resultsPage("www.naukri.com", 3);
  const next = e.make("button", { text: "Next", rect: { x: 400, y: 900, width: 80, height: 36 } });
  next.addEventListener("click", () => {
    // Acknowledge the click without changing the results.
    e.make("div", { role: "status", text: "Loading", rect: { x: 0, y: 950, width: 100, height: 20 } });
  });

  assert.equal(await e.sandbox.__autoApplyResultsWalker.goToNextPage(), false);
});

test("on a board that shows the job in a pane, opening waits for that job", async () => {
  // The list never goes away and the URL may not change, so "the page offers
  // an application" would be true from the start — every job would read as
  // opened the moment it was clicked, and the agent would apply to whatever
  // the pane was showing before.
  const titles = ["Python Developer", "Staff Data Engineer", "Android Lead", "QA Analyst", "Site Reliability Engineer"];
  const e = listingPage("https://www.linkedin.com/jobs/search/?keywords=python",
    (i) => `https://www.linkedin.com/jobs/view/401234567${i}`, 5, (i) => titles[i - 1]);
  // A results page that already offers an application, as these boards do.
  e.make("button", { text: "Easy Apply", rect: { x: 900, y: 100, width: 120, height: 40 } });

  const walker = e.sandbox.__autoApplyResultsWalker;
  const [first, second] = walker.findJobs();

  // Nothing has been clicked: no job is open, whatever the page offers.
  assert.equal(e.sandbox.__autoApplyTakeover.jobIsOpen(first), false);

  // The pane now shows the second job. Only that job counts as open.
  e.make("h1", { text: second.title, rect: { x: 900, y: 60, width: 400, height: 30 } });
  assert.equal(e.sandbox.__autoApplyTakeover.jobIsOpen(second), true);
  assert.equal(e.sandbox.__autoApplyTakeover.jobIsOpen(first), false);
});

// ---------------------------------------------------------------------------
// Applications embedded in a frame
// ---------------------------------------------------------------------------

/** Deliver a message to every listener the scripts registered. */
function deliver(e, msg) {
  const replies = [];
  let keptChannel = false;
  for (const listener of e.sandbox.__messageListeners) {
    if (listener(msg, {}, (reply) => replies.push(reply))) keptChannel = true;
  }
  return { replies, keptChannel };
}

test("a message to the page is answered by the page, not by a frame inside it", () => {
  // Every frame of a tab runs these scripts and sees every message sent to
  // that tab, and the first reply wins. An embedded ad answering "take over
  // this page" would take the run with it.
  const url = "https://acme.test/careers/1";
  const top = createEnvironment({ scripts: scriptsFor("acme.test"), url });
  const frame = createEnvironment({ scripts: scriptsFor("acme.test"), url, frame: true });

  assert.equal(deliver(top, { type: "TAKEOVER_STATUS" }).replies.length, 1);
  assert.equal(deliver(frame, { type: "TAKEOVER_STATUS" }).replies.length, 0,
    "a frame must leave the page's messages to the page");
});

test("a message addressed to a frame is answered by that frame, not by the page", () => {
  const url = "https://acme.test/careers/1";
  const top = createEnvironment({ scripts: scriptsFor("acme.test"), url });
  const frame = createEnvironment({ scripts: scriptsFor("acme.test"), url, frame: true });
  const addressed = { type: "TAKEOVER_APPLY_HERE", toFrame: true, job: { title: "Python Developer" } };

  assert.equal(deliver(top, addressed).keptChannel, false,
    "the page must not answer for one of its frames");
  assert.equal(deliver(frame, addressed).keptChannel, true);
});

test("a page with no way to apply asks whether one of its frames has the application", async () => {
  // A company careers page usually embeds its ATS rather than hosting the
  // form, so the page itself offers nothing the agent can see.
  const e = createEnvironment({ scripts: scriptsFor("acme.test"), url: "https://acme.test/careers/1" });
  e.sandbox.__autoApplyTakeover.configure({ settleMax: 100, openWaitMs: 200, applyBudgetMs: 600 });
  e.make("h1", { text: "Senior Python Developer", rect: { width: 400, height: 40 } });

  const asked = [];
  e.sandbox.chrome.runtime.sendMessage = async (msg) => {
    asked.push(msg.type);
    return msg.type === "APPLY_IN_FRAME"
      ? { ok: true, found: true, result: { submitted: true, reason: "embedded form submitted" } }
      : { ok: true };
  };

  const result = await e.sandbox.__autoApplyTakeover.applyToOpenJob({ title: "Senior Python Developer" });

  assert.ok(asked.includes("APPLY_IN_FRAME"), "the page must ask about its frames before giving up");
  assert.equal(result.submitted, true);
});

test("a frame that finds no application does not ask about frames of its own", async () => {
  // Otherwise a page and its frames hand the job back and forth.
  const e = createEnvironment({
    scripts: scriptsFor("acme.test"), url: "https://acme.test/careers/1", frame: true,
  });
  e.sandbox.__autoApplyTakeover.configure({ settleMax: 100, openWaitMs: 200, applyBudgetMs: 600 });

  const asked = [];
  e.sandbox.chrome.runtime.sendMessage = async (msg) => { asked.push(msg.type); return { ok: true }; };

  const result = await e.sandbox.__autoApplyTakeover.applyToOpenJob({ title: "Senior Python Developer" });

  assert.equal(asked.includes("APPLY_IN_FRAME"), false);
  assert.equal(result.submitted, false);
});

test("a page whose frames hold no application reports that, rather than the frame check", async () => {
  const e = createEnvironment({ scripts: scriptsFor("acme.test"), url: "https://acme.test/careers/1" });
  e.sandbox.__autoApplyTakeover.configure({ settleMax: 100, openWaitMs: 200, applyBudgetMs: 600 });
  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "APPLY_IN_FRAME" ? { ok: true, found: false } : { ok: true };

  const result = await e.sandbox.__autoApplyTakeover.applyToOpenJob({ title: "Senior Python Developer" });

  assert.equal(result.submitted, false);
  assert.match(result.reason, /no control that starts an application/i);
});

test("hiding the agent cursor hides it in embedded frames too", () => {
  // The cursor is drawn by each frame in its own document, so a frame that
  // ignored this would keep drawing one after the user turned it off.
  const url = "https://acme.test/careers/1";
  const top = createEnvironment({ scripts: scriptsFor("acme.test"), url });
  const frame = createEnvironment({ scripts: scriptsFor("acme.test"), url, frame: true });
  const hide = { type: "SET_CURSOR_VISIBLE", visible: false };

  assert.equal(frame.sandbox.__autoApplyCursor.isEnabled(), true, "on by default");

  deliver(top, hide);
  const framed = deliver(frame, hide);

  assert.equal(top.sandbox.__autoApplyCursor.isEnabled(), false);
  assert.equal(frame.sandbox.__autoApplyCursor.isEnabled(), false,
    "an embedded frame draws its own cursor and must hide it too");

  // The panel still gets exactly one answer, from the page.
  assert.equal(deliver(top, hide).replies.length, 1);
  assert.equal(framed.replies.length, 0);
});
