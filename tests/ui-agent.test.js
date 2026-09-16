// Unit tests for the AI Decision Engine (ui-agent.js).
//
// Tests run with: node --test tests/ui-agent.test.js
// Pure module tests — no DOM, no chrome.* required.

import test from "node:test";
import assert from "node:assert/strict";

import { buildCandidateContext, validateAction, decideAction } from "../src/lib/ui-agent.js";

// ---------------------------------------------------------------------------
// buildCandidateContext
// ---------------------------------------------------------------------------

test("buildCandidateContext returns empty object for null profile", () => {
  assert.deepEqual(buildCandidateContext(null), {});
});

test("buildCandidateContext maps expected profile fields", () => {
  const profile = {
    fullName: "Ada Lovelace",
    currentTitle: "Software Engineer",
    totalYears: 3,
    location: "Bangalore",
    preferredLocations: ["Bangalore", "Remote"],
    skills: [{ name: "Python", years: 3 }, { name: "Django", years: 2 }],
    excludedSkills: ["Flask"],
    noticePeriodDays: 0,
    workAuthorization: "Indian Citizen",
    willingToRelocate: true,
    salaryExpectation: "15 LPA",
    email: "ada@example.com",
    phone: "9999999999",
    headline: "Python developer with 3 years experience",
  };

  const ctx = buildCandidateContext(profile);

  assert.equal(ctx.name, "Ada Lovelace");
  assert.equal(ctx.currentTitle, "Software Engineer");
  assert.equal(ctx.experienceYears, 3);
  assert.equal(ctx.currentLocation, "Bangalore");
  assert.deepEqual(ctx.preferredLocations, ["Bangalore", "Remote"]);
  assert.equal(ctx.skills.length, 2);
  assert.deepEqual(ctx.excludedSkills, ["Flask"]);
  assert.equal(ctx.noticePeriodDays, 0);
  assert.equal(ctx.workAuthorization, "Indian Citizen");
  assert.equal(ctx.willingToRelocate, true);
  assert.equal(ctx.expectedSalary, "15 LPA");
  assert.equal(ctx.email, "ada@example.com");
  assert.equal(ctx.phone, "9999999999");
  assert.equal(ctx.headline, "Python developer with 3 years experience");
});

test("buildCandidateContext omits fields not present in profile", () => {
  const ctx = buildCandidateContext({ fullName: "Test User", totalYears: 1 });
  assert.ok(!("email" in ctx));
  assert.ok(!("phone" in ctx));
  assert.ok(!("noticePeriodDays" in ctx));
  assert.ok(!("workAuthorization" in ctx));
  assert.ok(!("preferredLocations" in ctx));
});

test("buildCandidateContext does not include API keys or internal fields", () => {
  const profile = {
    fullName: "Test",
    _validation: { ok: true },
    _apiKey: "sk-secret",
    resumeText: "Full resume text...",
  };
  const ctx = buildCandidateContext(profile);
  assert.ok(!("_validation" in ctx));
  assert.ok(!("_apiKey" in ctx));
  assert.ok(!("resumeText" in ctx));
});

test("buildCandidateContext handles noticePeriodDays = 0 correctly (falsy but valid)", () => {
  const ctx = buildCandidateContext({ noticePeriodDays: 0 });
  assert.equal(ctx.noticePeriodDays, 0);
});

// ---------------------------------------------------------------------------
// validateAction
// ---------------------------------------------------------------------------

test("validateAction accepts all allowed actions", () => {
  const allowed = ["click", "type", "select", "check", "uncheck", "upload", "wait", "ask_user", "finish", "stop"];
  for (const action of allowed) {
    const result = validateAction({ action });
    assert.equal(result.action, action, `action "${action}" should be accepted`);
  }
});

test("validateAction rejects unknown actions with a stop fallback", () => {
  const result = validateAction({ action: "eval" });
  assert.equal(result.action, "stop");
  assert.match(result.reason, /disallowed action/);
});

test("validateAction rejects null/undefined with a stop fallback", () => {
  assert.equal(validateAction(null).action, "stop");
  assert.equal(validateAction(undefined).action, "stop");
  assert.equal(validateAction("string").action, "stop");
});

test("validateAction preserves valid element_N target", () => {
  const result = validateAction({ action: "click", target: "element_42" });
  assert.equal(result.target, "element_42");
});

test("validateAction drops malformed targets (CSS selectors, XPaths, JS)", () => {
  const dangerous = ["#submit-btn", ".class > button", "eval(alert(1))", "document.body"];
  for (const target of dangerous) {
    const result = validateAction({ action: "click", target });
    assert.ok(!("target" in result), `dangerous target "${target}" should be dropped`);
  }
});

test("validateAction clamps confidence to [0, 1]", () => {
  assert.equal(validateAction({ action: "click", confidence: 2.5 }).confidence, 1);
  assert.equal(validateAction({ action: "click", confidence: -0.5 }).confidence, 0);
});

test("validateAction truncates excessively long value strings", () => {
  const longValue = "x".repeat(10000);
  const result = validateAction({ action: "type", value: longValue });
  assert.ok(result.value.length <= 4096);
});

test("validateAction strips additionalProperties not in the safe list", () => {
  const result = validateAction({
    action: "click",
    target: "element_1",
    arbitraryCode: "while(true){}",
    __proto__: null,
  });
  assert.ok(!("arbitraryCode" in result));
});

// ---------------------------------------------------------------------------
// decideAction
// ---------------------------------------------------------------------------

test("decideAction returns finish immediately when state is done", async () => {
  const snapshot = { page: { applicationState: "done" }, controls: [], questions: [], loading: false };
  const result = await decideAction(snapshot, {}, async () => ({}));
  assert.equal(result.action, "finish");
});

test("decideAction returns wait when page is loading", async () => {
  const snapshot = { page: { applicationState: "questionnaire" }, controls: [], questions: [], loading: true };
  const result = await decideAction(snapshot, {}, async () => ({}));
  assert.equal(result.action, "wait");
});

test("decideAction returns stop when snapshot is null", async () => {
  const result = await decideAction(null, {}, async () => ({}));
  assert.equal(result.action, "stop");
});

test("decideAction returns stop when askJSON is null", async () => {
  const snapshot = { page: { applicationState: "questionnaire" }, controls: [], questions: [], loading: false };
  const result = await decideAction(snapshot, {}, null);
  assert.equal(result.action, "stop");
});

test("decideAction tells the model which job it is applying for", async () => {
  // A company careers page can list many openings with an Apply each.
  let prompt = "";
  const mockAskJSON = async ({ user }) => { prompt = user; return { action: "stop", reason: "test" }; };
  const snapshot = { page: { applicationState: "ready" }, controls: [], questions: [], loading: false };

  await decideAction(snapshot, {}, mockAskJSON, { job: { title: "Python Developer", company: "Acme" } });

  assert.match(prompt, /ApplyingFor:[\s\S]*"title":"Python Developer"/);
  assert.match(prompt, /not this one, stop/);
});

test("decideAction passes validated action from LLM through", async () => {
  const snapshot = {
    page: { applicationState: "questionnaire" },
    controls: [
      { id: "element_1", type: "radio", text: "0 - (Immediate Joiner)", checked: false, visible: true },
      { id: "element_2", type: "button", text: "Save", visible: true },
    ],
    questions: [{ id: "question_1", text: "What is your notice period?" }],
    loading: false,
  };
  const profile = { noticePeriodDays: 0 };
  const mockAskJSON = async () => ({
    action: "select",
    target: "element_1",
    reason: "Candidate has 0-day notice period",
    confidence: 0.99,
  });

  const result = await decideAction(snapshot, profile, mockAskJSON);
  assert.equal(result.action, "select");
  assert.equal(result.target, "element_1");
  assert.equal(result.confidence, 0.99);
});

test("decideAction coerces invalid AI response to stop", async () => {
  const snapshot = {
    page: { applicationState: "questionnaire" },
    controls: [],
    questions: [],
    loading: false,
  };
  // AI returns garbage
  const mockAskJSON = async () => ({
    action: "executeScript",   // disallowed
    code: "window.location.href = 'evil.com'",
  });

  const result = await decideAction(snapshot, {}, mockAskJSON);
  assert.equal(result.action, "stop");
  assert.match(result.reason, /disallowed action/);
});

test("decideAction handles provider exception gracefully", async () => {
  const snapshot = {
    page: { applicationState: "questionnaire" },
    controls: [],
    questions: [],
    loading: false,
  };
  const mockAskJSON = async () => { throw new Error("503 service unavailable"); };

  const result = await decideAction(snapshot, {}, mockAskJSON);
  assert.equal(result.action, "stop");
  assert.match(result.reason, /503/);
});
