// Tests for the shared agent loop.
//
// These drive the real loop against a synthetic DOM with a scripted "model",
// so the behaviours under test are the loop's own decisions: when it escalates
// to visual context, when it refuses to claim submission, and when it stops
// for a security challenge.
//
// Run with: node --test tests/agent-loop.test.js

import test from "node:test";
import assert from "node:assert/strict";

import { createEnvironment } from "./helpers/dom-harness.js";

const SHARED = [
  "src/content/shared/interaction-core-bridge.js",
  "src/content/shared/observer-core.js",
  "src/content/shared/pointer-actions.js",
  "src/content/shared/diagnostics.js",
  "src/content/shared/executor-core.js",
  "src/content/shared/agent-loop-core.js",
];

/**
 * Build an environment whose AI_DECIDE_ACTION handler returns the given
 * scripted actions in order, recording every request the loop makes.
 */
function envWithModel(actions) {
  const requests = [];
  const e = createEnvironment({ scripts: SHARED });
  const queue = [...actions];

  e.sandbox.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type === "AI_DECIDE_ACTION") {
      requests.push(msg);
      const action = queue.shift() || { action: "stop", reason: "script exhausted" };
      return { ok: true, action };
    }
    return { ok: true };
  };

  return { e, requests };
}

/** A platform adapter backed by the shared observer. */
function adapterFor(e, overrides = {}) {
  return {
    name: "test",
    settleMax: 300,
    observe: () => e.sandbox.__autoApplyObserverCore.buildSnapshot({
      applicationState: overrides.state?.() || "applying",
    }),
    isComplete: overrides.isComplete || (() => false),
    checkAnomaly: overrides.checkAnomaly || (() => null),
  };
}

// ---------------------------------------------------------------------------
// Submission gating (Part 21)
// ---------------------------------------------------------------------------

test("a finish action without confirmation yields APPLICATION_STATUS_UNKNOWN, not submitted", async () => {
  const { e } = envWithModel([{ action: "finish", reason: "I think we are done" }]);
  e.make("button", { text: "Submit application", rect: { width: 160, height: 40 } });

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 3 });

  assert.equal(result.submitted, false);
  assert.equal(result.applicationStatus, "APPLICATION_STATUS_UNKNOWN");
  assert.match(result.reason, /confirmation/i);
});

test("a finish action IS honoured when the page shows a confirmation", async () => {
  const { e } = envWithModel([{ action: "finish" }]);
  e.make("h1", { text: "Your application was sent to Acme", rect: { width: 400, height: 40 } });

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 3 });

  assert.equal(result.submitted, true);
  assert.equal(result.applicationStatus, "APPLICATION_SUBMITTED");
});

test("the adapter's own completion check is authoritative", async () => {
  const { e } = envWithModel([]);
  const adapter = adapterFor(e, { isComplete: () => true });

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapter, { maxTurns: 3 });

  assert.equal(result.submitted, true);
  assert.equal(result.applicationStatus, "APPLICATION_SUBMITTED");
});

// ---------------------------------------------------------------------------
// Security (Part 9 — Test 7)
// ---------------------------------------------------------------------------

test("Test 7 — a CAPTCHA stops the run and never attempts to bypass it", async () => {
  const { e, requests } = envWithModel([{ action: "click", target: "element_1" }]);
  e.make("iframe", { src: "https://hcaptcha.com/captcha/v1/frame", rect: { width: 300, height: 400 } });

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 5 });

  assert.equal(result.stopped, true);
  assert.equal(result.blocked, true);
  assert.equal(result.submitted, false);
  assert.match(result.reason, /will not attempt to (solve or bypass|bypass)/i);
  assert.equal(requests.length, 0, "the model must not even be consulted past a challenge");
});

test("a platform anomaly stops the run before any interaction", async () => {
  const { e, requests } = envWithModel([{ action: "click", target: "element_1" }]);
  e.make("button", { text: "Easy Apply", rect: { width: 120, height: 40 } });
  const adapter = adapterFor(e, { checkAnomaly: () => "rate limit reached" });

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapter, { maxTurns: 5 });

  assert.equal(result.stopped, true);
  assert.equal(result.reason, "rate limit reached");
  assert.equal(requests.length, 0);
});

// ---------------------------------------------------------------------------
// Escalation on a click the site ignores (Parts 12, 23 — Test 6)
// ---------------------------------------------------------------------------

test("Test 6 — after a no-effect click the loop asks for a screenshot and reports the failure back", async () => {
  const { e, requests } = envWithModel([
    { action: "click", target: "element_1" },
    { action: "scroll", direction: "down", amount: 400 },
  ]);
  // A button nothing is listening to: every interaction method will be ignored.
  e.make("button", { text: "Easy Apply", rect: { x: 0, y: 0, width: 120, height: 40 } });

  await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 2 });

  assert.ok(!requests[0].needVisual, "the first turn is text-only");
  assert.equal(requests[1].needVisual, true, "the turn after a no-effect click must request visual context");
  assert.equal(requests[1].lastFailure.verdict, "ACTION_NO_EFFECT");
  assert.equal(requests[1].lastFailure.target, "element_1");
});

test("three consecutive no-effect actions hand off to the user rather than looping", async () => {
  const { e } = envWithModel([
    { action: "click", target: "element_1" },
    { action: "click", target: "element_1" },
    { action: "click", target: "element_1" },
    { action: "click", target: "element_1" },
  ]);
  e.make("button", { text: "Easy Apply", rect: { x: 0, y: 0, width: 120, height: 40 } });

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 8 });

  assert.equal(result.waitingForUser, true);
  assert.equal(result.submitted, false);
  assert.match(result.question, /did not respond/i);
});

test("a page with nothing observable escalates to a screenshot rather than spinning", async () => {
  const { e, requests } = envWithModel([
    { action: "ask_user", question: "I cannot see any controls — what should I do?" },
  ]);
  // No interactive elements at all: the DOM observation is empty.

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 4 });

  assert.equal(requests.length, 1, "the model must be consulted, not looped past");
  assert.equal(requests[0].needVisual, true, "an unreadable page must be shown visually");
  assert.equal(result.waitingForUser, true);
});

// ---------------------------------------------------------------------------
// Terminal actions
// ---------------------------------------------------------------------------

test("ask_user keeps the tab open and surfaces the question", async () => {
  const { e } = envWithModel([{ action: "ask_user", question: "What is your notice period?" }]);
  e.make("input", { type: "text", "aria-label": "Notice period", rect: { width: 200, height: 30 } });

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 3 });

  assert.equal(result.waitingForUser, true);
  assert.equal(result.question, "What is your notice period?");
  assert.equal(result.submitted, false);
});

test("stop ends the run without claiming submission", async () => {
  const { e } = envWithModel([{ action: "stop", reason: "unsupported flow" }]);
  e.make("button", { text: "Apply", rect: { width: 100, height: 40 } });

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 3 });

  assert.equal(result.stopped, true);
  assert.equal(result.submitted, false);
  assert.equal(result.applicationStatus, "APPLICATION_STATUS_UNKNOWN");
});

test("an external application is handed off rather than automated in place", async () => {
  const { e } = envWithModel([]);
  const adapter = adapterFor(e, { state: () => "external" });
  e.make("a", { text: "Apply on company website", href: "https://acme.test/1", rect: { width: 200, height: 40 } });

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapter, { maxTurns: 3 });

  assert.equal(result.external, true);
  assert.equal(result.submitted, false);
});

/**
 * An environment whose worker reports a new tab after `link` is clicked, and
 * records the tabs the loop asks it to close.
 */
function envWithNewTab(actions, linkProps) {
  const e = createEnvironment({ scripts: SHARED });
  const queue = [...actions];
  const closed = [];
  let opened = null;

  const link = e.make("a", { rect: { x: 0, y: 0, width: 200, height: 24 }, ...linkProps });
  link.addEventListener("click", () => {
    e.document.visibilityState = "hidden"; // the new tab takes focus
    opened = { id: 7, url: linkProps.href };
  });

  e.sandbox.chrome.runtime.sendMessage = async (msg) => {
    switch (msg.type) {
      case "AI_DECIDE_ACTION":
        return { ok: true, action: queue.shift() || { action: "stop", reason: "script exhausted" } };
      case "TAB_OPENED_SINCE":
        return opened ? { ok: true, opened: true, tab: opened } : { ok: true, opened: false };
      case "CLOSE_OPENED_TAB":
        closed.push(msg.tabId);
        opened = null;
        e.document.visibilityState = "visible";
        return { ok: true };
      default:
        return { ok: true };
    }
  };
  return { e, closed };
}

test("a click that opens an unrelated page in a new tab closes it and carries on", async () => {
  // e.g. the company name linking to a reviews site: the agent must not sit
  // stalled in a background tab until the user closes that page by hand.
  const { e, closed } = envWithNewTab(
    [{ action: "click", target: "element_1" }, { action: "stop", reason: "test" }],
    { href: "https://reviews.example/acme", text: "Acme Corp reviews" },
  );

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 3 });

  assert.deepEqual(closed, [7], "the stray tab must be closed");
  assert.equal(result.newTab, undefined);
  assert.equal(result.answered[0].result.verdict, "ACTION_NO_EFFECT");
  assert.match(result.answered[0].result.error, /unrelated page/);
});

test("an apply control that opens a new tab hands the application over to it", async () => {
  const { e, closed } = envWithNewTab(
    [{ action: "click", target: "element_1" }],
    { href: "https://careers.acme.test/apply/1", text: "Apply on company site" },
  );

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 3 });

  assert.deepEqual(closed, [], "the application tab must not be closed");
  assert.equal(result.newTab.id, 7);
  assert.equal(result.external, true);
  assert.equal(result.submitted, false);
});

test("reaching maxTurns does not claim submission", async () => {
  const { e } = envWithModel(Array(10).fill({ action: "wait", value: "100" }));
  e.make("button", { text: "Apply", rect: { width: 100, height: 40 } });

  const result = await e.sandbox.__autoApplyAgentLoopCore.run(adapterFor(e), { maxTurns: 3 });

  assert.equal(result.submitted, false);
  assert.match(result.reason, /maxTurns/);
});

// ---------------------------------------------------------------------------
// Tab actions are refused unless safe
// ---------------------------------------------------------------------------

test("a tab action is delegated to the service worker, never performed in the page", async () => {
  const e = createEnvironment({ scripts: SHARED });
  let sent = null;
  e.sandbox.chrome.runtime.sendMessage = async (msg) => { sent = msg; return { ok: true }; };

  const result = await e.sandbox.__autoApplyAgentLoopCore.dispatch(
    { action: "navigate", value: "https://acme.test/apply" },
    { settleMax: 200, getResume: async () => null },
  );

  assert.equal(sent.type, "AGENT_TAB_ACTION");
  assert.equal(sent.tabAction, "navigate");
  assert.equal(sent.url, "https://acme.test/apply");
  assert.equal(result.success, true);
});

test("a refused tab action is reported as failed, not silently ignored", async () => {
  const e = createEnvironment({ scripts: SHARED });
  e.sandbox.chrome.runtime.sendMessage = async () => ({ ok: false, error: "refused: only http(s) URLs" });

  const result = await e.sandbox.__autoApplyAgentLoopCore.dispatch(
    { action: "navigate", value: "javascript:alert(1)" },
    { settleMax: 200, getResume: async () => null },
  );

  assert.equal(result.success, false);
  assert.equal(result.result, "ACTION_FAILED");
  assert.match(result.error, /refused/);
});
