// Integration tests for the platform adapters.
//
// These load each adapter's real content scripts in dependency order against a
// synthetic DOM, confirming that the adapters still expose the API their
// callers use and that they route through the shared cores correctly.
//
// Run with: node --test tests/adapters.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createEnvironment } from "./helpers/dom-harness.js";

const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"),
);

/**
 * The scripts Chrome would inject into a page on this host.
 *
 * Several content_scripts blocks can match one page — the shared cores are
 * declared for https://*<span/>/* and the platform adapters for their own hosts — so
 * the effective script list is every matching block, in manifest order.
 */
function manifestScripts(hostname) {
  const files = [];
  for (const block of MANIFEST.content_scripts) {
    if (block.matches.some((pattern) => matchesHost(pattern, hostname))) {
      files.push(...block.js);
    }
  }
  assert.ok(files.length, `no content_scripts block matches ${hostname}`);
  return files;
}

/** Minimal match-pattern host test, enough for the patterns this manifest uses. */
function matchesHost(pattern, hostname) {
  const m = /^https?:\/\/([^/]+)\//.exec(pattern);
  if (!m) return false;
  const host = m[1];
  if (host === "*") return true;
  if (host.startsWith("*.")) {
    const base = host.slice(2);
    return hostname === base || hostname.endsWith("." + base);
  }
  return hostname === host;
}

// Derived from the manifest rather than hardcoded, so a change to the load
// order or a renamed file fails these tests instead of silently diverging.
// Every site gets the same scripts now, so this is the whole content layer.
const GENERIC = manifestScripts("boards.greenhouse.io");

// ---------------------------------------------------------------------------
// Job boards, read by the one adapter
//
// There are no per-site bundles: the same adapter reads a LinkedIn dialog, a
// Naukri apply button and an Indeed card, because it goes by what a page
// offers rather than by which site it is. These are the behaviours the
// per-site adapters used to guarantee, now asserted against the one path.
// ---------------------------------------------------------------------------

/** A job page on `url`, with only the scripts every site gets. */
const board = (url) => createEnvironment({ scripts: GENERIC, url });

test("an Easy Apply button makes a job page ready to apply", () => {
  const e = board("https://www.linkedin.com/jobs/view/1");
  e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  const snapshot = e.sandbox.genericObserver.observe();
  assert.equal(snapshot.page.applicationState, "ready");
  assert.ok(snapshot.applyCandidates.length > 0);
});

test("a board's own Apply button is ranked first on a job page", () => {
  const e = board("https://www.naukri.com/job-listings-python-developer-acme-120925");
  e.make("button", { id: "apply-button", text: "Apply", rect: { x: 400, y: 200, width: 100, height: 40 } });

  assert.equal(e.sandbox.genericObserver.observe().applyCandidates[0].name, "Apply");
});

test("an apply control found only by its aria-label still counts", () => {
  const e = board("https://www.linkedin.com/jobs/view/1");
  e.make("button", { "aria-label": "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  assert.equal(e.sandbox.genericObserver.observe().page.applicationState, "ready");
});

test("an open application dialog scopes the snapshot to itself", () => {
  const e = board("https://www.linkedin.com/jobs/view/1");
  e.make("button", { text: "Some page control outside the dialog", rect: { width: 200, height: 40 } });
  const dialog = e.make("div", { role: "dialog", rect: { x: 100, y: 100, width: 600, height: 400 } });
  e.make("input", { type: "text", "aria-label": "Phone", rect: { width: 200, height: 30 } }, dialog);
  e.make("button", { text: "Next", rect: { width: 80, height: 36 } }, dialog);

  const snapshot = e.sandbox.genericObserver.observe();
  assert.equal(snapshot.page.applicationState, "applying");

  const labels = snapshot.elements.map((x) => x.text);
  assert.ok(labels.includes("Next"));
  assert.ok(!labels.includes("Some page control outside the dialog"), "the snapshot must be scoped to the dialog");
});

test("an explicit confirmation is completion", () => {
  const e = board("https://www.linkedin.com/jobs/view/1");
  e.make("div", { role: "alert", text: "Your application was sent to Acme", rect: { width: 400, height: 40 } });

  assert.equal(e.sandbox.genericObserver.isComplete(), true);
  assert.equal(e.sandbox.genericObserver.observe().page.applicationState, "done");
});

test("a plain confirmation banner counts, not only a board's own markers", () => {
  // Some flows render a confirmation with no marker class at all. Missing it
  // made the agent report a successful application as a skip.
  const e = board("https://www.naukri.com/job-listings-python-developer-acme-120925");
  e.make("h1", { text: "Application submitted", rect: { width: 400, height: 30 } });

  assert.equal(e.sandbox.genericObserver.isComplete(), true);
});

test("an apply control that now reads Applied is proof the board recorded it", () => {
  // What the per-site "already applied" check used to provide.
  const e = board("https://www.naukri.com/job-listings-python-developer-acme-120925");
  e.make("button", { id: "apply-button", text: "Applied", rect: { x: 400, y: 200, width: 100, height: 40 } });

  assert.equal(e.sandbox.genericObserver.isComplete(), true);
});

test("an Applied badge on a results list is never read as this job being done", () => {
  // The guard on the above. A list shows "Applied" on the jobs already done
  // while still offering Apply on the rest; only a page with nothing left to
  // apply to counts, or every unapplied job on the page reads as submitted.
  const e = board("https://www.naukri.com/python-jobs");
  e.make("button", { text: "Applied", rect: { x: 10, y: 10, width: 100, height: 36 } });
  e.make("button", { text: "Apply", rect: { x: 10, y: 60, width: 100, height: 36 } });

  assert.equal(e.sandbox.genericObserver.isComplete(), false);
});

test("a step advancing is not completion", () => {
  const e = board("https://www.linkedin.com/jobs/view/1");
  const dialog = e.make("div", { role: "dialog", rect: { width: 600, height: 400 } });
  e.make("button", { text: "Review", rect: { width: 80, height: 36 } }, dialog);
  e.make("button", { text: "Submit application", rect: { width: 160, height: 36 } }, dialog);

  assert.equal(e.sandbox.genericObserver.isComplete(), false);
});

test("a results page is never mistaken for a completed application", () => {
  // Whole-page text on a results page carries other jobs' statuses, which
  // must not read as this application having been submitted.
  const e = board("https://www.naukri.com/python-jobs");
  e.make("div", { text: "Recommended jobs", rect: { width: 300, height: 24 } });
  e.make("div", { text: "Application sent 2 days ago", rect: { width: 300, height: 24 } });

  assert.equal(e.sandbox.genericObserver.isComplete(), false);
});

test("a CAPTCHA frame blocks the page", () => {
  const e = board("https://www.linkedin.com/jobs/view/1");
  e.make("iframe", {
    src: "https://www.google.com/recaptcha/api2/bframe?k=x",
    rect: { x: 0, y: 0, width: 300, height: 400 },
  });

  assert.equal(e.sandbox.genericObserver.observe().page.applicationState, "blocked");
});

test("a board that has signed the user out is a login wall, not an application", () => {
  // What LinkedIn's checkpoint rule used to catch, by path rather than host.
  const e = board("https://www.linkedin.com/checkpoint/challenge/1");
  e.make("div", { class: "auth-wall", text: "Join now to see this job", rect: { width: 400, height: 200 } });

  assert.equal(e.sandbox.genericObserver.observe().page.applicationState, "login");
});

test("a questionnaire panel's controls are all visible to the model", () => {
  const e = board("https://www.naukri.com/job-listings-python-developer-acme-120925");
  const panel = e.make("div", { class: "singleselect-radiobutton", rect: { x: 0, y: 0, width: 600, height: 400 } });
  e.make("button", { text: "Update my profile instead", rect: { width: 200, height: 36 } }, panel);
  e.make("button", { text: "Save", rect: { width: 80, height: 36 } }, panel);

  const labels = e.sandbox.genericObserver.observe().elements.map((x) => x.text);
  // An older filter accepted only ^(save|send|next|submit|apply|continue|proceed|done|ok)$.
  assert.ok(labels.includes("Save"));
  assert.ok(labels.includes("Update my profile instead"));
});

test("an apply control that ignores .click() is opened with real pointer events", async () => {
  // The reported failure: the agent says it clicked Apply and the board does
  // not progress.
  const e = board("https://www.linkedin.com/jobs/view/1");
  e.sandbox.__autoApplyTakeover.configure({ settleMax: 200, openWaitMs: 400, applyBudgetMs: 1500 });

  const btn = e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });
  btn.click = () => { /* accepted by the DOM, ignored by the application */ };
  btn.addEventListener("pointerdown", () => {
    const dialog = e.make("div", { role: "dialog", rect: { x: 100, y: 100, width: 600, height: 400 } });
    e.make("input", { type: "text", "aria-label": "Phone", rect: { width: 200, height: 30 } }, dialog);
    e.make("button", { text: "Submit application", rect: { width: 160, height: 36 } }, dialog);
  });

  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "AI_DECIDE_ACTION"
      ? { ok: true, action: { action: "stop", reason: "end of test" } }
      : { ok: true };

  const result = await e.sandbox.__autoApplyTakeover.applyToOpenJob({ title: "Python Developer" });

  assert.equal(e.sandbox.genericObserver.observe().page.applicationState, "applying",
    "the application dialog must have opened");
  assert.equal(result.submitted, false, "opening the dialog is not submission");
});

test("an unresponsive apply control is reported, not claimed as success", async () => {
  const e = board("https://www.linkedin.com/jobs/view/1");
  e.sandbox.__autoApplyTakeover.configure({ settleMax: 200, openWaitMs: 300, applyBudgetMs: 1200 });
  // A button nothing listens to at all.
  e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  const result = await e.sandbox.__autoApplyTakeover.applyToOpenJob({ title: "Python Developer" });

  assert.equal(result.submitted, false);
  assert.match(result.reason, /did not open/i);
});

// ---------------------------------------------------------------------------
// Generic ATS (Test 8 — the external handoff target)
// ---------------------------------------------------------------------------

test("the generic adapter loads and exposes the API its callers use", () => {
  const e = createEnvironment({ scripts: GENERIC, url: "https://boards.greenhouse.io/acme/jobs/1" });
  assert.equal(typeof e.sandbox.genericObserver.observe, "function");
  assert.equal(typeof e.sandbox.genericObserver.isComplete, "function");
  assert.equal(typeof e.sandbox.genericExecutor.executeAction, "function");
});

test("Test 8 — the generic observer reads an external ATS form with no platform selectors", () => {
  const e = createEnvironment({ scripts: GENERIC, url: "https://boards.greenhouse.io/acme/jobs/1" });
  const form = e.make("form", { rect: { x: 0, y: 0, width: 800, height: 600 } });
  e.make("input", { type: "text", "aria-label": "Full name", rect: { width: 300, height: 30 } }, form);
  e.make("input", { type: "email", "aria-label": "Email", rect: { width: 300, height: 30 } }, form);
  e.make("input", { type: "file", "aria-label": "Resume", rect: { width: 300, height: 30 } }, form);
  e.make("button", { text: "Submit application", rect: { width: 160, height: 40 } }, form);

  const snapshot = e.sandbox.genericObserver.observe();

  assert.equal(snapshot.page.applicationState, "applying");
  assert.equal(snapshot.page.platform, "generic");
  const labels = snapshot.elements.map((x) => x.text || x.ariaLabel);
  for (const wanted of ["Full name", "Email", "Resume", "Submit application"]) {
    assert.ok(labels.includes(wanted), `the generic observer must see "${wanted}"`);
  }
});

test("Test 6 — a generic page whose only entry point is unusually worded is still ranked", () => {
  const e = createEnvironment({ scripts: GENERIC, url: "https://acme.test/careers/1" });
  e.make("div", { role: "button", text: "Begin application", rect: { x: 100, y: 200, width: 180, height: 44 } });

  const snapshot = e.sandbox.genericObserver.observe();
  assert.equal(snapshot.page.applicationState, "ready");
  assert.equal(snapshot.applyCandidates[0].name, "Begin application");
});

test("the generic observer confirms submission only on an explicit message", () => {
  const e = createEnvironment({ scripts: GENERIC, url: "https://boards.greenhouse.io/acme/jobs/1" });
  e.make("h1", { text: "Thank you for applying to Acme", rect: { width: 400, height: 40 } });

  assert.equal(e.sandbox.genericObserver.isComplete(), true);
  assert.equal(e.sandbox.genericObserver.observe().page.applicationState, "done");
});

test("Test 7 — the generic observer blocks on a security challenge rather than proceeding", () => {
  const e = createEnvironment({ scripts: GENERIC, url: "https://acme.test/careers/1" });
  e.make("h1", { text: "Please verify you are human before continuing", rect: { width: 400, height: 40 } });

  assert.equal(e.sandbox.genericObserver.observe().page.applicationState, "blocked");
});

test("the generic observer reports a login wall as login, not as an application", () => {
  const e = createEnvironment({ scripts: GENERIC, url: "https://acme.test/careers/1" });
  e.make("h1", { text: "Sign in to continue your application", rect: { width: 400, height: 40 } });
  e.make("input", { type: "password", rect: { width: 200, height: 30 } });

  assert.equal(e.sandbox.genericObserver.observe().page.applicationState, "login");
});

// ---------------------------------------------------------------------------
// What the manifest actually loads
// ---------------------------------------------------------------------------

test("every host the manifest covers loads a complete agent", () => {
  // The shared cores are declared for all sites and the adapters for their own
  // hosts, so a real page gets the union. Each host must end up with a working
  // agent — including an arbitrary company site, which is the external-ATS case.
  for (const [hostname, url] of [
    ["www.naukri.com", "https://www.naukri.com/job-listings-x-1"],
    ["www.linkedin.com", "https://www.linkedin.com/jobs/view/1"],
    ["boards.greenhouse.io", "https://boards.greenhouse.io/acme/jobs/1"],
  ]) {
    const e = createEnvironment({ scripts: manifestScripts(hostname), url });
    for (const core of [
      "__autoApplyInteractionCore", "__autoApplyObserverCore", "__autoApplyPointer",
      "__autoApplyExecutorCore", "__autoApplyAgentLoopCore", "__autoApplyDiagnostics",
      "__autoApplyCursor", "__autoApplyResultsWalker", "__autoApplyTakeover",
    ]) {
      assert.ok(e.sandbox[core], `${core} must be present on ${hostname}`);
    }
    // Every page must have at least the generic adapter to fall back on.
    assert.ok(e.sandbox.genericObserver, `genericObserver must be present on ${hostname}`);
  }
});

test("the agent runs on an arbitrary company site, not only the job boards", () => {
  const e = createEnvironment({
    scripts: manifestScripts("careers.acme.test"),
    url: "https://careers.acme.test/apply/42",
  });
  assert.ok(e.sandbox.__autoApplyTakeover, "takeover must be available on any https site");
  assert.equal(e.sandbox.__autoApplyTakeover.adapterForCurrentPage().name, "generic");
});

// ---------------------------------------------------------------------------
// Shared behaviour
// ---------------------------------------------------------------------------

test("a snapshot has the same shape on every site", () => {
  const sites = ["https://www.linkedin.com/jobs/view/1", "https://in.indeed.com/viewjob?jk=abc",
                 "https://www.naukri.com/job-listings-x-1", "https://acme.test/jobs/1"];

  for (const snapshot of sites.map((url) => board(url).sandbox.genericObserver.observe())) {
    for (const key of ["page", "questions", "elements", "controls", "applyCandidates", "errors", "loading", "fingerprint"]) {
      assert.ok(key in snapshot, `every snapshot must carry "${key}"`);
    }
    // `controls` is retained as an alias so existing call sites keep working.
    assert.equal(snapshot.controls, snapshot.elements);
  }
});

test("element IDs are reassigned on each observation and never reused across pages", () => {
  const e = createEnvironment({ scripts: GENERIC, url: "https://acme.test/jobs/1" });
  e.make("button", { text: "Apply now", rect: { width: 120, height: 40 } });

  const first = e.sandbox.genericObserver.observe().elements[0].id;
  const second = e.sandbox.genericObserver.observe().elements[0].id;

  assert.equal(first, "element_1");
  assert.equal(second, "element_1", "the registry resets each observation");
});

// ---------------------------------------------------------------------------
// Forms that are not applications
// ---------------------------------------------------------------------------

test("a careers page whose only form is a contact form has no application on it", () => {
  // Taken from a real company page a Naukri external apply leads to: a job
  // description and a WordPress contact form, with no way to apply and
  // nowhere to attach a CV. Reading that form as the application left the
  // agent filling it in turn after turn, and would have sent the company a
  // message rather than an application.
  const e = createEnvironment({ scripts: GENERIC, url: "https://acme.test/jr-python-developer/" });
  e.make("h1", { text: "Jr Python Developer / Software Engineer", rect: { width: 600, height: 40 } });

  const form = e.make("form", { rect: { x: 0, y: 300, width: 600, height: 400 } });
  e.make("input", { type: "text", "aria-label": "Your name", rect: { width: 300, height: 30 } }, form);
  e.make("input", { type: "email", "aria-label": "Your email", rect: { width: 300, height: 30 } }, form);
  e.make("input", { type: "text", "aria-label": "Subject", rect: { width: 300, height: 30 } }, form);
  e.make("textarea", { "aria-label": "Your message", rect: { width: 300, height: 120 } }, form);
  e.make("input", { type: "submit", value: "Submit", rect: { width: 100, height: 36 } }, form);

  assert.equal(e.sandbox.genericObserver.findApplicationRoot(), null,
    "a name/email/subject/message form is a contact form, not an application");
  assert.equal(e.sandbox.genericObserver.observe().page.applicationState, "unknown",
    "with no application and no apply control, the page state is unknown so the job is skipped");
});

test("a form that takes a CV is the application, even worded plainly", () => {
  const e = createEnvironment({ scripts: GENERIC, url: "https://acme.test/careers/1" });
  const form = e.make("form", { rect: { x: 0, y: 0, width: 800, height: 600 } });
  e.make("input", { type: "text", "aria-label": "Your name", rect: { width: 300, height: 30 } }, form);
  e.make("input", { type: "email", "aria-label": "Your email", rect: { width: 300, height: 30 } }, form);
  e.make("input", { type: "file", "aria-label": "Upload your CV", rect: { width: 300, height: 30 } }, form);

  assert.equal(e.sandbox.genericObserver.findApplicationRoot(), form);
  assert.equal(e.sandbox.genericObserver.observe().page.applicationState, "applying");
});
