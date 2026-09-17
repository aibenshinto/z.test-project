// DOM-level tests for the shared observer and executor.
//
// These exercise the real content-script modules against a small synthetic
// DOM, so the properties under test are the ones that actually run in the
// browser — in particular that a click which executes but changes nothing is
// reported as ACTION_NO_EFFECT rather than success.
//
// Run with: node --test tests/executor-dom.test.js

import test from "node:test";
import assert from "node:assert/strict";

import { createEnvironment } from "./helpers/dom-harness.js";

const SHARED = [
  "src/content/shared/interaction-core-bridge.js",
  "src/content/shared/observer-core.js",
  "src/content/shared/pointer-actions.js",
  "src/content/shared/diagnostics.js",
  "src/content/shared/executor-core.js",
];

function env(opts = {}) {
  return createEnvironment({ scripts: SHARED, ...opts });
}

// ---------------------------------------------------------------------------
// Observation (Part 2 — Test 4)
// ---------------------------------------------------------------------------

test("the observer reports controls that the old keyword filter would have hidden", () => {
  const e = env();
  e.make("button", { text: "Start application", rect: { x: 10, y: 10, width: 160, height: 40 } });
  e.make("button", { text: "Get started", rect: { x: 10, y: 60, width: 160, height: 40 } });
  e.make("button", { text: "Learn more about Acme", rect: { x: 10, y: 110, width: 160, height: 40 } });

  const snapshot = e.sandbox.__autoApplyObserverCore.buildSnapshot({});
  const labels = snapshot.elements.map((el) => el.text);

  // The old observer required next|continue|review|submit|apply|upload|done|save.
  assert.ok(labels.includes("Start application"));
  assert.ok(labels.includes("Get started"));
  assert.ok(labels.includes("Learn more about Acme"), "non-apply controls must still be visible to the model");
});

test("Test 4 — a button with no text is observed via its aria-label and ranked as an apply candidate", () => {
  const e = env();
  e.make("button", { "aria-label": "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  const snapshot = e.sandbox.__autoApplyObserverCore.buildSnapshot({});
  const el = snapshot.elements.find((x) => x.ariaLabel === "Easy Apply");

  assert.ok(el, "the aria-label-only button must appear in the snapshot");
  assert.equal(el.tag, "button");
  assert.deepEqual(el.rect, { x: 500, y: 300, width: 120, height: 40 });
  assert.equal(snapshot.applyCandidates[0].id, el.id);
});

test("a div with role=button and aria-label is observed as an interactive control", () => {
  const e = env();
  e.make("div", { role: "button", "aria-label": "Apply now", rect: { x: 0, y: 0, width: 100, height: 40 } });

  const snapshot = e.sandbox.__autoApplyObserverCore.buildSnapshot({});
  const el = snapshot.elements.find((x) => x.ariaLabel === "Apply now");
  assert.ok(el);
  assert.equal(el.role, "button");
});

test("element metadata carries the fields the schema promises", () => {
  const e = env();
  e.make("button", {
    text: "Easy Apply", "aria-label": "Easy Apply", type: "button",
    rect: { x: 500, y: 300, width: 120, height: 40 },
  });

  const el = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0];
  for (const key of ["id", "tag", "role", "text", "ariaLabel", "title", "visible", "enabled", "disabled", "rect"]) {
    assert.ok(key in el, `metadata must include "${key}"`);
  }
  assert.match(el.id, /^element_\d+$/);
  assert.equal(el.visible, true);
  assert.equal(el.enabled, true);
});

test("invisible and password controls are excluded", () => {
  const e = env();
  e.make("button", { text: "Hidden", style: { display: "none" } });
  e.make("button", { text: "Zero", rect: { width: 0, height: 0 } });
  e.make("input", { type: "password", rect: { width: 200, height: 30 } });
  e.make("button", { text: "Visible", rect: { width: 100, height: 40 } });

  const labels = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements.map((x) => x.text);
  assert.deepEqual(labels, ["Visible"]);
});

test("a disabled control is reported, but marked disabled", () => {
  const e = env();
  e.make("button", { text: "Submit application", disabled: true, rect: { width: 120, height: 40 } });

  const el = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0];
  assert.equal(el.disabled, true);
  assert.equal(el.enabled, false);
});

// ---------------------------------------------------------------------------
// Click verification (Parts 7, 10, 11 — Tests 1, 2, 9)
// ---------------------------------------------------------------------------

test("Test 1 — a click that opens a modal is ACTION_CONFIRMED", async () => {
  const e = env();
  const btn = e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  btn.addEventListener("click", () => {
    const modal = e.make("div", { role: "dialog", rect: { x: 100, y: 100, width: 600, height: 400 } });
    e.make("input", { type: "text", "aria-label": "Phone", rect: { width: 200, height: 30 } }, modal);
  });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 600 });

  assert.equal(result.result, "ACTION_CONFIRMED");
  assert.equal(result.success, true);
  assert.equal(result.diagnostics.method, "dom_click");
});

test("Test 9 — a click the page ignores is ACTION_NO_EFFECT, never success", async () => {
  const e = env();
  // A button with no handler: .click() dispatches fine and nothing happens.
  e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 400 });

  assert.equal(result.result, "ACTION_NO_EFFECT");
  assert.equal(result.success, false, "a no-effect click must never report success");
  assert.equal(result.verified, false);
  assert.match(result.error, /did not react/i);
});

test("Test 2 — a page that ignores .click() but honours real pointer events is recovered by the fallback", async () => {
  const e = env();
  const btn = e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  // Simulate a page whose handler is bound to pointerdown, not to the
  // synthetic activation behaviour of element.click().
  btn.click = () => { /* accepted by the DOM, ignored by the app */ };
  btn.addEventListener("pointerdown", () => {
    e.make("div", { role: "dialog", rect: { x: 100, y: 100, width: 600, height: 400 } });
  });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 400 });

  assert.equal(result.result, "ACTION_CONFIRMED");
  assert.equal(result.diagnostics.method, "pointer_click", "it must have escalated to a pointer click");
  assert.equal(result.diagnostics.attempts[0].result, "ACTION_NO_EFFECT");
  assert.equal(result.diagnostics.attempts[0].method, "dom_click");
  assert.equal(result.diagnostics.retryCount, 1);
});

test("the pointer click aims at the element's own rect, not a fixed coordinate", async () => {
  const e = env();
  const btn = e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });
  btn.click = () => {};

  let seen = null;
  btn.addEventListener("pointerdown", (evt) => {
    seen = { x: evt.clientX, y: evt.clientY };
    e.make("div", { role: "dialog", rect: { width: 300, height: 200 } });
  });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 400 });

  assert.deepEqual(seen, { x: 560, y: 320 }, "the point must be the centre of the current rect");
});

test("the full pointer sequence is dispatched in the expected order", async () => {
  const e = env();
  const btn = e.make("button", { text: "Easy Apply", rect: { x: 0, y: 0, width: 100, height: 40 } });
  btn.click = () => {};

  const order = [];
  for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    btn.addEventListener(type, () => order.push(type));
  }

  await e.sandbox.__autoApplyPointer.pointerClick(btn);

  assert.deepEqual(order, ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
});

test("double_click actually dispatches two activations, not one", async () => {
  const e = env();
  const el = e.make("div", { role: "button", text: "Expand", rect: { x: 0, y: 0, width: 120, height: 40 } });

  let clicks = 0;
  let dbl = 0;
  el.addEventListener("click", () => {
    clicks++;
    if (clicks === 2) e.make("div", { role: "dialog", rect: { width: 300, height: 200 } });
  });
  el.addEventListener("dblclick", () => { dbl++; });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { double: true, settleMax: 400 });

  assert.equal(clicks, 2, "a double click must produce two click activations");
  assert.equal(dbl, 1, "the dblclick event must also fire");
  assert.equal(result.result, "ACTION_CONFIRMED");
  assert.equal(result.diagnostics.method, "double_click");
});

test("a click is retried no more than the configured budget", async () => {
  const e = env();
  e.make("button", { text: "Easy Apply", rect: { x: 0, y: 0, width: 100, height: 40 } });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { maxRetries: 2, settleMax: 200 });

  assert.equal(result.result, "ACTION_NO_EFFECT");
  assert.equal(result.diagnostics.attempts.length, 2);
});

test("a disabled target is refused before any interaction is attempted", async () => {
  const e = env();
  e.make("button", { text: "Submit application", disabled: true, rect: { width: 120, height: 40 } });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 200 });

  assert.equal(result.success, false);
  assert.match(result.error, /disabled/i);
});

// ---------------------------------------------------------------------------
// Stale elements (Part 13 — Test 3)
// ---------------------------------------------------------------------------

test("Test 3 — a rerendered Apply button is re-resolved and clicked", async () => {
  const e = env();
  const original = e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;

  // React tears out the observed node and mounts an equivalent one.
  original.remove();
  const replacement = e.make("button", { text: "Easy Apply", rect: { x: 500, y: 302, width: 120, height: 40 } });
  let clicked = false;
  replacement.addEventListener("click", () => {
    clicked = true;
    e.make("div", { role: "dialog", rect: { width: 300, height: 200 } });
  });

  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 400 });

  assert.equal(clicked, true, "the replacement node must have received the click");
  assert.equal(result.result, "ACTION_CONFIRMED");
});

test("a target that vanished with no equivalent replacement is reported, not silently clicked", async () => {
  const e = env();
  const btn = e.make("button", { text: "Easy Apply", rect: { x: 0, y: 0, width: 120, height: 40 } });
  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;

  btn.remove();
  e.make("button", { text: "Withdraw application", rect: { x: 0, y: 0, width: 120, height: 40 } });

  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { maxRetries: 2, settleMax: 200 });

  assert.equal(result.success, false);
  assert.match(result.error, /stale|not in the current snapshot/i);
});

test("resolveLive rebinds a logical ID to the live node after a rerender", () => {
  const e = env();
  const original = e.make("button", { text: "Next", rect: { x: 10, y: 10, width: 80, height: 30 } });
  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;

  original.remove();
  const replacement = e.make("button", { text: "Next", rect: { x: 10, y: 12, width: 80, height: 30 } });

  const resolved = e.sandbox.__autoApplyObserverCore.resolveLive(id);
  assert.equal(resolved.el, replacement);
  assert.equal(resolved.reresolved, true);
});

// ---------------------------------------------------------------------------
// Typing and selection
// ---------------------------------------------------------------------------

test("typing is verified against the field's resulting value", async () => {
  const e = env();
  e.make("input", { type: "text", "aria-label": "Email", rect: { width: 200, height: 30 } });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.type(id, "ada@example.com");

  assert.equal(result.result, "ACTION_CONFIRMED");
  assert.equal(result.success, true);
});

test("typing into a contenteditable field uses textContent, not value", async () => {
  const e = env();
  const el = e.make("div", {
    contenteditable: "true", "aria-label": "Cover note", rect: { width: 300, height: 80 },
  });
  el.isContentEditable = true;

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.type(id, "Hello");

  assert.equal(result.success, true);
  assert.equal(el.textContent, "Hello");
});

test("a field that rejects input is reported as no effect", async () => {
  const e = env();
  const input = e.make("input", { type: "text", "aria-label": "Locked", rect: { width: 200, height: 30 } });
  // A field that refuses to hold a value, as a masked or controlled input may.
  Object.defineProperty(input, "value", { get: () => "", set: () => {}, configurable: true });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.type(id, "hello");

  assert.equal(result.result, "ACTION_NO_EFFECT");
  assert.equal(result.success, false);
});

test("selecting a radio group honours the requested option, not the first one", async () => {
  // The dangerous case: a radio group is shown to the model as one element
  // whose id is its FIRST option. Checking that regardless of `value` would
  // answer "Yes" to a question the model answered "No".
  const e = env();
  const group = e.make("div", { rect: { x: 0, y: 0, width: 400, height: 100 } });

  const yes = e.make("input", { type: "radio", name: "sponsor", value: "yes", id: "r-yes", rect: { x: 0, y: 0, width: 20, height: 20 } }, group);
  const yesLabel = e.make("label", { for: "r-yes", text: "Yes", rect: { x: 24, y: 0, width: 60, height: 20 } }, group);
  const no = e.make("input", { type: "radio", name: "sponsor", value: "no", id: "r-no", rect: { x: 0, y: 30, width: 20, height: 20 } }, group);
  e.make("label", { for: "r-no", text: "No", rect: { x: 24, y: 30, width: 60, height: 20 } }, group);

  for (const radio of [yes, no]) {
    radio.addEventListener("click", () => {
      yes.checked = radio === yes;
      no.checked = radio === no;
    });
  }

  const snapshot = e.sandbox.__autoApplyObserverCore.buildSnapshot({});
  const radiogroup = snapshot.elements.find((x) => x.role === "radiogroup");
  assert.ok(radiogroup, "the group must be published as a single radiogroup element");

  const result = await e.sandbox.__autoApplyExecutorCore.select(radiogroup.id, "No");

  assert.equal(result.success, true);
  assert.equal(no.checked, true, "the requested option must be the one selected");
  assert.equal(yes.checked, false, "the first option must NOT be selected");
  void yesLabel;
});

test("selecting a radio option that does not exist fails rather than picking one", async () => {
  const e = env();
  const group = e.make("div", { rect: { width: 400, height: 60 } });
  e.make("input", { type: "radio", name: "q", value: "yes", id: "y", rect: { width: 20, height: 20 } }, group);
  e.make("label", { for: "y", text: "Yes", rect: { x: 24, width: 60, height: 20 } }, group);

  const snapshot = e.sandbox.__autoApplyObserverCore.buildSnapshot({});
  const rg = snapshot.elements.find((x) => x.role === "radiogroup");
  const result = await e.sandbox.__autoApplyExecutorCore.select(rg.id, "Maybe");

  assert.equal(result.success, false);
  assert.match(result.error, /no option matching/i);
});

test("typing into a <select> is routed to select instead of throwing", async () => {
  // A model confusing `type` with `select` must not abort the whole run.
  const e = env();
  const sel = e.make("select", { "aria-label": "Years of experience", rect: { width: 200, height: 30 } });
  sel.options = [
    { textContent: "3", value: "3" },
    { textContent: "5", value: "5" },
  ];

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.type(id, "5");

  assert.equal(result.action, "select");
  assert.equal(sel.value, "5");
});

test("typing into an element that cannot accept text fails cleanly", async () => {
  const e = env();
  e.make("button", { text: "Easy Apply", rect: { width: 120, height: 40 } });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.type(id, "hello");

  assert.equal(result.result, "ACTION_FAILED");
  assert.match(result.error, /cannot be typed into/i);
});

test("a key press that changes nothing is NO_EFFECT, not success", async () => {
  const e = env();
  e.make("input", { type: "text", "aria-label": "Search", rect: { width: 200, height: 30 } });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.keyPress("ENTER", id);

  assert.equal(result.result, "ACTION_NO_EFFECT");
  assert.equal(result.success, false);
});

test("checking a checkbox is verified against .checked", async () => {
  const e = env();
  const box = e.make("input", { type: "checkbox", "aria-label": "I agree", rect: { width: 20, height: 20 } });
  box.addEventListener("click", () => { box.checked = !box.checked; });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.setChecked(id, true, "check");

  assert.equal(result.success, true);
  assert.equal(box.checked, true);
});

test("a checkbox that refuses to change is reported as no effect", async () => {
  const e = env();
  e.make("input", { type: "checkbox", "aria-label": "Stuck", rect: { width: 20, height: 20 } });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.setChecked(id, true, "check");

  assert.equal(result.result, "ACTION_NO_EFFECT");
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Diagnostics (Part 14)
// ---------------------------------------------------------------------------

test("every click produces a diagnostic record with the documented fields", async () => {
  const e = env();
  e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  await e.sandbox.__autoApplyExecutorCore.click(id, { maxRetries: 1, settleMax: 200 });

  const [record] = e.sandbox.__autoApplyDiagnostics.getRecords();
  for (const key of [
    "action", "target", "targetText", "method", "timestamp",
    "visible", "enabled", "rect", "beforeState", "afterState", "result", "retryCount",
  ]) {
    assert.ok(key in record, `the diagnostic must include "${key}"`);
  }
  assert.equal(record.action, "click");
  assert.equal(record.targetText, "Easy Apply");
  assert.equal(record.result, "ACTION_NO_EFFECT");
  assert.deepEqual(record.rect, { x: 500, y: 300, width: 120, height: 40 });
});

test("the diagnostic records each attempt and the method it used", async () => {
  const e = env();
  const btn = e.make("button", { text: "Easy Apply", rect: { x: 0, y: 0, width: 120, height: 40 } });
  btn.click = () => {};
  btn.addEventListener("pointerdown", () => {
    e.make("div", { role: "dialog", rect: { width: 300, height: 200 } });
  });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 300 });

  const methods = result.diagnostics.attempts.map((a) => `${a.method}:${a.result}`);
  assert.deepEqual(methods, ["dom_click:ACTION_NO_EFFECT", "pointer_click:ACTION_CONFIRMED"]);
});

// ---------------------------------------------------------------------------
// Scrolling and keys
// ---------------------------------------------------------------------------

test("scrolling reports whether the page actually moved", async () => {
  const e = env();
  const moved = await e.sandbox.__autoApplyExecutorCore.scroll("down", 600);
  assert.equal(moved.result, "ACTION_CONFIRMED");
  assert.equal(e.sandbox.scrollY, 600);
});

test("an unsupported key is refused by the pointer module", async () => {
  const e = env();
  const res = await e.sandbox.__autoApplyPointer.keyPress("F12");
  assert.equal(res.executed, false);
});

test("Enter is dispatched as a real key sequence", async () => {
  const e = env();
  const input = e.make("input", { type: "text", "aria-label": "Search", rect: { width: 200, height: 30 } });

  const seen = [];
  for (const t of ["keydown", "keypress", "keyup"]) input.addEventListener(t, (ev) => seen.push(`${t}:${ev.key}`));

  await e.sandbox.__autoApplyPointer.keyPress("ENTER", input);
  assert.deepEqual(seen, ["keydown:Enter", "keypress:Enter", "keyup:Enter"]);
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

test("the fingerprint changes when a modal opens", () => {
  const e = env();
  const before = e.sandbox.__autoApplyObserverCore.fingerprint();
  e.make("div", { role: "dialog", rect: { x: 0, y: 0, width: 400, height: 300 } });
  const after = e.sandbox.__autoApplyObserverCore.fingerprint();

  assert.equal(before.modalOpen, false);
  assert.equal(after.modalOpen, true);
  assert.equal(e.sandbox.__autoApplyInteractionCore.diffPageState(before, after).changed, true);
});

test("the fingerprint is stable when nothing changes", () => {
  const e = env();
  e.make("button", { text: "Easy Apply", rect: { width: 120, height: 40 } });
  const a = e.sandbox.__autoApplyObserverCore.fingerprint();
  const b = e.sandbox.__autoApplyObserverCore.fingerprint();
  assert.equal(e.sandbox.__autoApplyInteractionCore.diffPageState(a, b).changed, false);
});

// ---------------------------------------------------------------------------
// Clicks that open a tab
// ---------------------------------------------------------------------------

test("a click that navigates this page AND opens a tab reports the new tab", async () => {
  // Naukri's "Apply on company site" does both at once: the company's
  // application opens in a new tab, and this tab is sent to Naukri's own
  // record of the click. Treating the navigation as the whole story left the
  // agent working on that record — a page with nothing to apply with — while
  // the real application sat untouched in the other tab.
  const e = env({ url: "https://www.naukri.com/job-listings-python-developer-acme-1" });
  const asked = [];
  e.sandbox.chrome.runtime.sendMessage = async (msg) => {
    asked.push(msg);
    return msg.type === "TAB_OPENED_SINCE"
      ? { ok: true, opened: true, tab: { id: 42, url: "https://acme.test/jr-python-developer/" } }
      : { ok: true };
  };

  const btn = e.make("button", { text: "Apply on company site", rect: { x: 500, y: 300, width: 180, height: 40 } });
  btn.addEventListener("click", () => {
    e.sandbox.location.href = "https://www.naukri.com/myapply/showAcp?jquery=1&file=301025501137";
  });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 400 });

  assert.equal(result.result, "ACTION_CONFIRMED");
  assert.equal(result.openedTab?.id, 42, "the caller must be told where the application actually went");
  assert.ok(asked.some((m) => m.type === "TAB_OPENED_SINCE"),
    "a click that navigated must still ask whether it opened a tab");
});

test("a click that changes only this page reports no opened tab", async () => {
  const e = env();
  e.sandbox.chrome.runtime.sendMessage = async () => ({ ok: true, opened: false });

  const btn = e.make("button", { text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } });
  btn.addEventListener("click", () => {
    const modal = e.make("div", { role: "dialog", rect: { x: 100, y: 100, width: 600, height: 400 } });
    e.make("input", { type: "text", "aria-label": "Phone", rect: { width: 200, height: 30 } }, modal);
  });

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements[0].id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 400 });

  assert.equal(result.result, "ACTION_CONFIRMED");
  assert.equal(result.openedTab, null);
});
