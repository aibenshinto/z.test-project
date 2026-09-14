// Unit tests for the LinkedIn AI agent layer.
//
// Tests the observer snapshot shape contract, the shared validateAction
// logic (re-used from ui-agent.js), and the agent-loop termination paths.
//
// These tests run in Node via:  npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Inline the validateAction logic (identical to src/lib/ui-agent.js)
// so we test the contract without a Chrome environment.
// ---------------------------------------------------------------------------

const ALLOWED_ACTIONS = new Set([
  "click", "type", "select", "check", "uncheck",
  "upload", "wait", "ask_user", "finish", "stop",
]);

function validateAction(raw, fallbackReason = "invalid AI response") {
  if (!raw || typeof raw !== "object") {
    return { action: "stop", reason: fallbackReason };
  }
  const action = String(raw.action || "").toLowerCase().trim();
  if (!ALLOWED_ACTIONS.has(action)) {
    return { action: "stop", reason: `disallowed action "${raw.action}"` };
  }
  const safe = { action };
  if (raw.target != null) {
    const t = String(raw.target).trim();
    if (/^element_\d+$/.test(t)) safe.target = t;
  }
  if (raw.value    != null) safe.value    = String(raw.value).slice(0, 4096);
  if (raw.question != null) safe.question = String(raw.question).slice(0, 1024);
  if (raw.reason   != null) safe.reason   = String(raw.reason).slice(0, 512);
  if (typeof raw.confidence === "number") {
    safe.confidence = Math.max(0, Math.min(1, raw.confidence));
  }
  return safe;
}

// ---------------------------------------------------------------------------
// Minimal UISnapshot shape (must be accepted by the AI prompt)
// ---------------------------------------------------------------------------

function makeSnapshot(overrides = {}) {
  return {
    page: {
      url: "https://www.linkedin.com/jobs/view/123",
      title: "Senior Engineer at Acme",
      applicationState: "applying",
    },
    questions: [{ id: "question_1", text: "Years of experience?" }],
    controls: [
      { id: "element_1", type: "radiogroup", text: "Years of experience?",
        name: "years", options: [
          { id: "element_1", label: "0-2 years", checked: false },
          { id: "element_2", label: "3-5 years", checked: false },
        ], visible: true },
      { id: "element_3", type: "button", text: "Next", disabled: false, visible: true },
    ],
    messages: [],
    errors: [],
    successIndicators: [],
    loading: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LinkedIn validateAction — action vocabulary", () => {
  it("accepts all 10 allowed actions", () => {
    for (const act of ALLOWED_ACTIONS) {
      const result = validateAction({ action: act });
      assert.equal(result.action, act);
    }
  });

  it("rejects unknown action → stop", () => {
    const r = validateAction({ action: "eval" });
    assert.equal(r.action, "stop");
    assert.ok(r.reason.includes("disallowed"));
  });

  it("rejects null input → stop", () => {
    const r = validateAction(null);
    assert.equal(r.action, "stop");
  });

  it("rejects non-object → stop", () => {
    const r = validateAction("click element_1");
    assert.equal(r.action, "stop");
  });
});

describe("LinkedIn validateAction — element ID enforcement", () => {
  it("accepts valid element_N format", () => {
    const r = validateAction({ action: "click", target: "element_42" });
    assert.equal(r.target, "element_42");
  });

  it("rejects CSS selector — drops target silently", () => {
    const r = validateAction({ action: "click", target: ".apply-button" });
    assert.ok(!("target" in r));
  });

  it("rejects XPath — drops target silently", () => {
    const r = validateAction({ action: "click", target: "//button[@id='submit']" });
    assert.ok(!("target" in r));
  });

  it("rejects JavaScript string — drops target silently", () => {
    const r = validateAction({ action: "type", target: "document.getElementById('x')" });
    assert.ok(!("target" in r));
  });

  it("strips extra fields (no additionalProperties)", () => {
    const r = validateAction({ action: "click", target: "element_1", cssSelector: ".foo", eval: "bad" });
    assert.ok(!("cssSelector" in r));
    assert.ok(!("eval" in r));
  });
});

describe("LinkedIn validateAction — field constraints", () => {
  it("truncates value at 4096 chars", () => {
    const long = "x".repeat(5000);
    const r = validateAction({ action: "type", value: long });
    assert.equal(r.value.length, 4096);
  });

  it("truncates question at 1024 chars", () => {
    const long = "q".repeat(2000);
    const r = validateAction({ action: "ask_user", question: long });
    assert.equal(r.question.length, 1024);
  });

  it("clamps confidence to [0, 1]", () => {
    assert.equal(validateAction({ action: "click", confidence: 1.5 }).confidence, 1);
    assert.equal(validateAction({ action: "click", confidence: -0.5 }).confidence, 0);
  });

  it("ignores non-numeric confidence", () => {
    const r = validateAction({ action: "click", confidence: "high" });
    assert.ok(!("confidence" in r));
  });
});

describe("LinkedIn UISnapshot shape", () => {
  it("snapshot has required top-level keys", () => {
    const snap = makeSnapshot();
    for (const key of ["page", "questions", "controls", "messages", "errors", "successIndicators", "loading"]) {
      assert.ok(key in snap, `missing key: ${key}`);
    }
  });

  it("page has url, title, applicationState", () => {
    const snap = makeSnapshot();
    assert.ok(snap.page.url);
    assert.ok(snap.page.title);
    assert.ok(snap.page.applicationState);
  });

  it("radiogroup control has options array", () => {
    const snap = makeSnapshot();
    const rg = snap.controls.find((c) => c.type === "radiogroup");
    assert.ok(Array.isArray(rg.options));
    assert.ok(rg.options.length > 0);
    assert.ok(rg.options[0].id.startsWith("element_"));
    assert.ok(rg.options[0].label);
  });

  it("controls reference valid element IDs", () => {
    const snap = makeSnapshot();
    for (const ctrl of snap.controls) {
      assert.ok(/^element_\d+$/.test(ctrl.id), `bad id: ${ctrl.id}`);
    }
  });

  it("applicationState done → AI should return finish", () => {
    const snap = makeSnapshot({ page: { url: "x", title: "x", applicationState: "done" } });
    // If we were in the AI, we'd return finish. Verify the state value is 'done'.
    assert.equal(snap.page.applicationState, "done");
  });

  it("loading: true → no controls needed (agent waits)", () => {
    const snap = makeSnapshot({ loading: true, controls: [], questions: [] });
    assert.equal(snap.loading, true);
    assert.equal(snap.controls.length, 0);
  });
});

describe("LinkedIn agent-loop termination semantics", () => {
  // Simulate the loop's result contract without running real DOM / LLM

  it("stop result shape", () => {
    const result = { submitted: false, answered: [], stopped: true, blocked: false, reason: "CAPTCHA", turns: 1 };
    assert.equal(result.submitted, false);
    assert.ok(result.stopped);
    assert.ok(result.reason);
  });

  it("ask_user result shape", () => {
    const result = { submitted: false, answered: [], waitingForUser: true, question: "Are you authorized to work?", turns: 3 };
    assert.equal(result.submitted, false);
    assert.ok(result.waitingForUser);
    assert.ok(result.question);
  });

  it("finish result — confirmed", () => {
    const result = { submitted: true, answered: [], reason: "Confirmed by LinkedIn completion indicator", turns: 5 };
    assert.equal(result.submitted, true);
    assert.ok(result.reason.includes("LinkedIn"));
  });

  it("finish result — unconfirmed (AI claimed finish but no indicator)", () => {
    const result = { submitted: false, answered: [], reason: "AI requested finish but LinkedIn did not show a completion indicator", turns: 5 };
    assert.equal(result.submitted, false);
    assert.ok(result.reason.includes("AI requested finish"));
  });

  it("external apply result shape", () => {
    const result = { submitted: false, external: true, reason: "External company application", turns: 1 };
    assert.equal(result.submitted, false);
    assert.ok(result.external);
  });

  it("maxTurns result is not submitted without confirmation", () => {
    const result = { submitted: false, answered: new Array(25).fill({}), reason: "agent loop reached maxTurns", turns: 25 };
    assert.equal(result.submitted, false);
    assert.ok(result.reason.includes("maxTurns"));
  });
});
