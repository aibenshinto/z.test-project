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

test("the adapter is chosen from the page the agent is on right now", () => {
  for (const [hostname, expected] of [
    ["www.naukri.com", "naukri"],
    ["www.linkedin.com", "linkedin"],
    ["boards.greenhouse.io", "generic"],
    ["careers.acme.test", "generic"],
  ]) {
    const e = createEnvironment({ scripts: scriptsFor(hostname), url: `https://${hostname}/x` });
    assert.equal(
      e.sandbox.__autoApplyTakeover.adapterForCurrentPage().name, expected,
      `${hostname} should use the ${expected} adapter`,
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
    msg.type === "AI_DECIDE_ACTION" ? { ok: true, action: { action: "finish" } } : { ok: true, adopted: false };

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
    return { ok: true, adopted: false };
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
    msg.type === "AI_DECIDE_ACTION" ? { ok: true, action: { action: "stop", reason: "no form" } } : { ok: true, adopted: false };

  const result = await e.sandbox.__autoApplyTakeover.run({ maxJobs: 2, maxPages: 1 });

  assert.equal(result.appliedCount, 0, "an unresponsive apply button must never count as applied");
  assert.ok(result.skippedCount >= 1);
});

test("maxJobs bounds the run", async () => {
  const { e, jobs } = resultsPage("www.naukri.com", 5);
  wireJobFlow(e, jobs);

  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "AI_DECIDE_ACTION" ? { ok: true, action: { action: "finish" } } : { ok: true, adopted: false };

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
    msg.type === "AI_DECIDE_ACTION" ? { ok: true, action: { action: "finish" } } : { ok: true, adopted: false };

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
      : { ok: true, adopted: false };

  const result = await t.run({ maxJobs: 3, maxPages: 1 });

  assert.equal(result.ok, true);
  assert.ok(result.appliedCount + result.skippedCount < 3, "the run must not process every job after Stop");
});
