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

function manifestScripts(hostFragment) {
  const block = MANIFEST.content_scripts.find((cs) =>
    cs.matches.some((m) => m.includes(hostFragment)));
  assert.ok(block, `no content_scripts block matches ${hostFragment}`);
  return block.js;
}

const SHARED = [
  "src/content/shared/highlight.js",
  "src/content/shared/interaction-core-bridge.js",
  "src/content/shared/observer-core.js",
  "src/content/shared/pointer-actions.js",
  "src/content/shared/diagnostics.js",
  "src/content/shared/executor-core.js",
  "src/content/shared/agent-loop-core.js",
];

const LINKEDIN = [
  ...SHARED,
  "src/content/linkedin/selectors.js",
  "src/content/linkedin/observer.js",
  "src/content/linkedin/executor.js",
  "src/content/linkedin/agent-loop.js",
];

const GENERIC = [
  ...SHARED,
  "src/content/generic/observer.js",
  "src/content/generic/executor.js",
];

// ---------------------------------------------------------------------------
// LinkedIn
// ---------------------------------------------------------------------------

test("the LinkedIn adapter loads and exposes the API its callers use", () => {
  const e = createEnvironment({ scripts: LINKEDIN, url: "https://www.linkedin.com/jobs/view/1" });

  assert.equal(typeof e.sandbox.linkedinObserver.observe, "function");
  assert.equal(typeof e.sandbox.linkedinObserver.isComplete, "function");
  assert.equal(typeof e.sandbox.linkedinExecutor.executeAction, "function");
  assert.equal(typeof e.sandbox.linkedinAgentLoop.runAgentLoop, "function");
  // getElement is retained for any caller that still resolves IDs directly.
  assert.equal(typeof e.sandbox.linkedinObserver.getElement, "function");
});

test("LinkedIn reports state ready when an Easy Apply button is present", () => {
  const e = createEnvironment({ scripts: LINKEDIN, url: "https://www.linkedin.com/jobs/view/1" });
  e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  const snapshot = e.sandbox.linkedinObserver.observe();
  assert.equal(snapshot.page.applicationState, "ready");
  assert.equal(snapshot.page.platform, "linkedin");
  assert.ok(snapshot.applyCandidates.length > 0);
});

test("LinkedIn finds an Easy Apply button that has only an aria-label", () => {
  const e = createEnvironment({ scripts: LINKEDIN, url: "https://www.linkedin.com/jobs/view/1" });
  e.make("button", { "aria-label": "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  assert.equal(e.sandbox.linkedinObserver.observe().page.applicationState, "ready");
});

test("LinkedIn reports state applying once the dialog is open, and scopes the snapshot to it", () => {
  const e = createEnvironment({ scripts: LINKEDIN, url: "https://www.linkedin.com/jobs/view/1" });
  e.make("button", { text: "Some page control outside the dialog", rect: { width: 200, height: 40 } });
  const dialog = e.make("div", { role: "dialog", rect: { x: 100, y: 100, width: 600, height: 400 } });
  e.make("input", { type: "text", "aria-label": "Phone", rect: { width: 200, height: 30 } }, dialog);
  e.make("button", { text: "Next", rect: { width: 80, height: 36 } }, dialog);

  const snapshot = e.sandbox.linkedinObserver.observe();
  assert.equal(snapshot.page.applicationState, "applying");

  const labels = snapshot.elements.map((x) => x.text);
  assert.ok(labels.includes("Next"));
  assert.ok(!labels.includes("Some page control outside the dialog"), "the snapshot must be scoped to the dialog");
});

test("LinkedIn treats an explicit confirmation as complete", () => {
  const e = createEnvironment({ scripts: LINKEDIN, url: "https://www.linkedin.com/jobs/view/1" });
  e.make("div", { role: "alert", text: "Your application was sent to Acme", rect: { width: 400, height: 40 } });

  assert.equal(e.sandbox.linkedinObserver.isComplete(), true);
  assert.equal(e.sandbox.linkedinObserver.observe().page.applicationState, "done");
});

test("LinkedIn does not treat a step advancing as completion", () => {
  const e = createEnvironment({ scripts: LINKEDIN, url: "https://www.linkedin.com/jobs/view/1" });
  const dialog = e.make("div", { role: "dialog", rect: { width: 600, height: 400 } });
  e.make("button", { text: "Review", rect: { width: 80, height: 36 } }, dialog);
  e.make("button", { text: "Submit application", rect: { width: 160, height: 36 } }, dialog);

  assert.equal(e.sandbox.linkedinObserver.isComplete(), false);
});

test("LinkedIn reports blocked when a CAPTCHA frame is present", () => {
  const e = createEnvironment({ scripts: LINKEDIN, url: "https://www.linkedin.com/jobs/view/1" });
  e.make("iframe", {
    src: "https://www.google.com/recaptcha/api2/bframe?k=x",
    rect: { x: 0, y: 0, width: 300, height: 400 },
  });

  assert.equal(e.sandbox.linkedinObserver.observe().page.applicationState, "blocked");
});

test("LinkedIn detects an external company application", () => {
  const e = createEnvironment({ scripts: LINKEDIN, url: "https://www.linkedin.com/jobs/view/1" });
  e.make("a", { text: "Apply on company website", href: "https://acme.test/jobs/1", rect: { width: 200, height: 40 } });

  assert.equal(e.sandbox.linkedinObserver.observe().page.applicationState, "external");
});

test("LinkedIn opens an Easy Apply button that ignores .click() but honours pointer events", async () => {
  // The reported failure: the agent says it clicked Apply and LinkedIn does
  // not progress. Loaded through the full manifest chain so apply.js and
  // main.js are exercised too.
  const e = createEnvironment({
    scripts: MANIFEST.content_scripts.find((c) => c.matches[0].includes("linkedin")).js,
    url: "https://www.linkedin.com/jobs/view/1",
  });

  const btn = e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });
  btn.click = () => { /* accepted by the DOM, ignored by the application */ };
  btn.addEventListener("pointerdown", () => {
    const dialog = e.make("div", { role: "dialog", rect: { x: 100, y: 100, width: 600, height: 400 } });
    e.make("button", { text: "Submit application", rect: { width: 160, height: 36 } }, dialog);
  });

  e.sandbox.chrome.runtime.sendMessage = async (msg) =>
    msg.type === "AI_DECIDE_ACTION"
      ? { ok: true, action: { action: "stop", reason: "end of test" } }
      : { ok: true };

  const result = await e.sandbox.linkedinApply.apply({});

  assert.ok(e.sandbox.linkedinObserver.dialogRoot(), "the Easy Apply dialog must have opened");
  assert.equal(result.submitted, false, "opening the dialog is not submission");
});

test("LinkedIn reports a genuinely unresponsive Apply button instead of claiming success", async () => {
  const e = createEnvironment({
    scripts: MANIFEST.content_scripts.find((c) => c.matches[0].includes("linkedin")).js,
    url: "https://www.linkedin.com/jobs/view/1",
  });
  // A button nothing listens to at all.
  e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  const result = await e.sandbox.linkedinApply.apply({});

  assert.equal(result.submitted, false);
  assert.equal(result.applicationStatus, "APPLICATION_NOT_SUBMITTED");
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
// Naukri — loaded exactly as the manifest declares it
// ---------------------------------------------------------------------------

test("every content-script chain in the manifest loads in the declared order", () => {
  for (const block of MANIFEST.content_scripts) {
    const e = createEnvironment({ scripts: block.js, url: "https://www.naukri.com/job/1" });
    for (const core of [
      "__autoApplyInteractionCore", "__autoApplyObserverCore", "__autoApplyPointer",
      "__autoApplyExecutorCore", "__autoApplyAgentLoopCore", "__autoApplyDiagnostics",
    ]) {
      assert.ok(e.sandbox[core], `${core} must be present for ${block.matches[0]}`);
    }
  }
});

test("the Naukri adapter loads and exposes the API its callers use", () => {
  const e = createEnvironment({
    scripts: manifestScripts("naukri"),
    url: "https://www.naukri.com/job-listings-x-1",
  });

  assert.equal(typeof e.sandbox.naukriObserver.observe, "function");
  assert.equal(typeof e.sandbox.naukriObserver.isComplete, "function");
  assert.equal(typeof e.sandbox.naukriExecutor.executeAction, "function");
  assert.equal(typeof e.sandbox.naukriAgentLoop.runAgentLoop, "function");
  assert.equal(typeof e.sandbox.naukriApply.apply, "function");
});

test("Naukri reports state ready and ranks its Apply button", () => {
  const e = createEnvironment({
    scripts: manifestScripts("naukri"),
    url: "https://www.naukri.com/job-listings-x-1",
  });
  e.make("button", { id: "apply-button", text: "Apply", rect: { x: 400, y: 200, width: 100, height: 40 } });

  const snapshot = e.sandbox.naukriObserver.observe();
  assert.equal(snapshot.page.applicationState, "ready");
  assert.equal(snapshot.page.platform, "naukri");
  assert.equal(snapshot.applyCandidates[0].name, "Apply");
});

test("Naukri surfaces questionnaire controls the old exact-match filter would have dropped", () => {
  const e = createEnvironment({
    scripts: manifestScripts("naukri"),
    url: "https://www.naukri.com/job-listings-x-1",
  });
  const panel = e.make("div", { class: "singleselect-radiobutton", rect: { x: 0, y: 0, width: 600, height: 400 } });
  e.make("button", { text: "Update my profile instead", rect: { width: 200, height: 36 } }, panel);
  e.make("button", { text: "Save", rect: { width: 80, height: 36 } }, panel);

  const labels = e.sandbox.naukriObserver.observe().elements.map((x) => x.text);
  // The old filter accepted only ^(save|send|next|submit|apply|continue|proceed|done|ok)$.
  assert.ok(labels.includes("Save"));
  assert.ok(labels.includes("Update my profile instead"));
});

// ---------------------------------------------------------------------------
// Shared behaviour across adapters
// ---------------------------------------------------------------------------

test("every adapter produces the same snapshot shape", () => {
  const linkedin = createEnvironment({ scripts: LINKEDIN, url: "https://www.linkedin.com/jobs/view/1" });
  const generic = createEnvironment({ scripts: GENERIC, url: "https://acme.test/jobs/1" });

  for (const snapshot of [linkedin.sandbox.linkedinObserver.observe(), generic.sandbox.genericObserver.observe()]) {
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
