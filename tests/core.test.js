import test from "node:test";
import assert from "node:assert/strict";

import { evaluateJob, evaluateJobWithModel } from "../src/lib/evaluator.js";
import {
  answerFromProfile,
  classifyQuestion,
  findSimilarAnswer,
  isSensitiveQuestion,
  profileHintForQuestion,
} from "../src/lib/questions.js";
import { emptySession, STATES, transition } from "../src/lib/agent-fsm.js";

const profile = {
  currentTitle: "Python Developer",
  totalYears: 2,
  preferredLocations: ["Bangalore", "Remote"],
  skills: [{ name: "Python", years: 2 }, { name: "Django", years: 2 }],
  excludedSkills: ["Flask"],
};

test("evaluates a plausible role as an automatic-apply candidate", () => {
  const result = evaluateJob({
    title: "Python Developer",
    summary: "Build Django and Python APIs.",
    tags: ["Python", "Django"],
    experience: "1-3 Yrs",
    location: "Bangalore",
    postedOn: "Today",
  }, profile);

  assert.equal(result.decision, "APPLY");
  assert.ok(result.match_score >= 65);
});

test("hard-skips a role with a material experience gap", () => {
  const result = evaluateJob({
    title: "Backend Engineer",
    summary: "Python services",
    tags: ["Python"],
    experience: "5-8 Yrs",
    location: "Bangalore",
    postedOn: "Today",
  }, profile);

  assert.equal(result.decision, "SKIP");
  assert.match(result.missing_requirements[0], /5\+ years/);
});

test("honors explicit company and keyword exclusions", () => {
  const result = evaluateJob({
    title: "Python Developer",
    company: "Example Corp",
    summary: "Django and Python services",
    tags: ["Python"],
    experience: "1-3 Yrs",
    location: "Bangalore",
    postedOn: "Today",
  }, profile, { preferences: { companiesToExclude: ["Example Corp"] } });

  assert.equal(result.decision, "SKIP");
  assert.deepEqual(result.missing_requirements, ["company is excluded by preference"]);
});

test("treats Indian job locations as preferred when nationwide preference is enabled", () => {
  const result = evaluateJob({
    title: "Python Developer",
    summary: "Python and Django services",
    tags: ["Python", "Django"],
    experience: "1-3 Yrs",
    location: "Hyderabad, Pune, Bengaluru",
    postedOn: "Today",
  }, profile, { preferences: { applyAnywhereInIndia: true } });

  assert.ok(result.reasons.includes("location matches anywhere-in-India preference"));
});

test("a model response cannot override an experience hard-skip", async () => {
  const result = await evaluateJobWithModel({
    title: "Backend Engineer",
    summary: "Python services",
    tags: ["Python"],
    experience: "6-8 Yrs",
    location: "Bangalore",
    postedOn: "Today",
  }, profile, async () => ({
    match_score: 99,
    decision: "APPLY",
    reasons: ["model was optimistic"],
    missing_requirements: [],
    risk_flags: [],
  }));

  assert.equal(result.decision, "SKIP");
});

test("reuses semantically similar user answers but never fabricates missing skill years", () => {
  const hit = findSimilarAnswer({
    "do you require visa sponsorship": {
      question: "Do you require visa sponsorship?",
      answer: "No",
      source: "user",
      confidence: 1,
    },
  }, "Will you need sponsorship for a work visa?");

  assert.equal(hit?.entry.answer, "No");
  assert.equal(isSensitiveQuestion("Will you need sponsorship for a work visa?"), true);
  assert.equal(
    answerFromProfile(classifyQuestion("How many years of experience do you have with Rust?"), profile),
    null,
  );
  assert.equal(
    answerFromProfile(classifyQuestion("How many years of experience do you have with Flask?"), profile),
    "0",
  );
  assert.equal(answerFromProfile(classifyQuestion("First name"), { ...profile, fullName: "Ada Lovelace" }), "Ada");
  assert.equal(answerFromProfile(classifyQuestion("Surname"), { ...profile, fullName: "Ada Lovelace" }), "Lovelace");
  assert.equal(profileHintForQuestion("What is your notice period?").fieldId, "pNotice");
  assert.equal(profileHintForQuestion("How many years of experience do you have with Rust?").fieldId, "pSkills");
});

test("agent session only accepts safe, resumable transitions", () => {
  const discovering = transition(emptySession(), STATES.DISCOVERING_JOB, { jobId: "job-1" });
  const evaluating = transition(discovering, STATES.EVALUATING_JOB);
  const waiting = transition(evaluating, STATES.WAITING_FOR_USER);
  assert.equal(waiting.jobId, "job-1");
  assert.throws(() => transition(emptySession(), STATES.SUBMITTING), /illegal transition/);
});
