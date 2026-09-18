// Unit tests for the interaction core — the rules that decide whether the
// WEBSITE actually reacted, as opposed to whether JavaScript ran.
//
// Run with: node --test tests/interaction-core.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ACTION_RESULT, APPLICATION_STATUS, MAX_CLICK_RETRIES,
  accessibleName, rankApplyIntent, findApplyCandidates,
  diffPageState, hasSubmissionEvidence, hasProgressEvidence,
  classifyApplicationStatus, classifyClickOutcome, nextClickStrategy,
  pointerPointFor, isStaleTarget, scoreCandidateMatch, resolveLogicalTarget,
  detectSecurityChallenge,
} from "../src/lib/interaction-core.js";

// ---------------------------------------------------------------------------
// Apply detection (Part 4, Tests 4 + 5)
// ---------------------------------------------------------------------------

test("accessibleName combines every naming source, not just text", () => {
  assert.equal(accessibleName({ text: "", ariaLabel: "Easy Apply" }), "Easy Apply");
  assert.equal(accessibleName({ title: "Apply now" }), "Apply now");
  assert.equal(accessibleName(null), "");
});

test("Test 4 — a button with no text is detected through its aria-label", () => {
  const el = { id: "element_12", tag: "button", role: "button", text: "", ariaLabel: "Easy Apply", visible: true };
  assert.ok(rankApplyIntent(el) >= 0.9, "aria-label-only Easy Apply must rank as a strong candidate");
});

test("Test 5 — alternative wordings are recognised as application starters", () => {
  const wordings = [
    "Apply", "Apply now", "Easy Apply", "Easy apply", "Apply to this job",
    "Start application", "Start applying", "Begin application",
    "Continue application", "Get started", "Next step",
  ];
  for (const text of wordings) {
    const el = { tag: "button", role: "button", text, visible: true };
    assert.ok(rankApplyIntent(el) > 0, `"${text}" should be recognised as apply intent`);
  }
});

test("a div with role=button and aria-label is treated as an interactive apply control", () => {
  const el = { tag: "div", role: "button", text: "", ariaLabel: "Apply now", visible: true };
  assert.ok(rankApplyIntent(el) >= 0.9);
});

test("unrelated controls do not rank as apply candidates", () => {
  for (const text of ["Sign in", "Save job", "Share", "Report this job", "Message"]) {
    assert.equal(rankApplyIntent({ tag: "button", text, visible: true }), 0, `"${text}" must not rank`);
  }
});

test("a disabled apply button ranks well below an enabled one", () => {
  const enabled = { tag: "button", role: "button", text: "Easy Apply", visible: true };
  const disabled = { tag: "button", role: "button", text: "Easy Apply", visible: true, disabled: true };
  assert.ok(rankApplyIntent(disabled) < rankApplyIntent(enabled));
});

test("findApplyCandidates ranks strong matches above weak generic ones", () => {
  const elements = [
    { id: "element_1", tag: "button", text: "Continue", visible: true },
    { id: "element_2", tag: "button", text: "Easy Apply", visible: true },
    { id: "element_3", tag: "button", text: "Save", visible: true },
  ];
  const ranked = findApplyCandidates(elements);
  assert.equal(ranked[0].id, "element_2");
  assert.ok(!ranked.some((c) => c.id === "element_3"));
});

// ---------------------------------------------------------------------------
// Click outcome classification (Parts 7, 10, 11 — Tests 1, 2, 9)
// ---------------------------------------------------------------------------

const BASE = {
  url: "https://example.com/jobs/123",
  title: "Job",
  modalOpen: false,
  controlCount: 10,
  fieldCount: 0,
  errorCount: 0,
  bodyTextHash: "aaa",
};

test("Test 1 — a click that opens a modal is ACTION_CONFIRMED", () => {
  const after = { ...BASE, modalOpen: true, fieldCount: 6, bodyTextHash: "bbb" };
  const out = classifyClickOutcome({ executed: true, before: BASE, after });
  assert.equal(out.result, ACTION_RESULT.CONFIRMED);
  assert.ok(out.changes.includes("modal"));
});

test("Test 9 — a click that executes but changes nothing is ACTION_NO_EFFECT, not success", () => {
  const out = classifyClickOutcome({ executed: true, before: BASE, after: { ...BASE } });
  assert.equal(out.result, ACTION_RESULT.NO_EFFECT);
  assert.notEqual(out.result, ACTION_RESULT.CONFIRMED);
});

test("incidental text drift does not confirm a click that did nothing", () => {
  // A job page mutates on its own: relative timestamps tick, lazy rails paint.
  // Treating that as the site reacting would confirm a dead click.
  const after = { ...BASE, bodyTextHash: "changed-on-its-own" };
  const out = classifyClickOutcome({ executed: true, before: BASE, after });

  assert.equal(out.result, ACTION_RESULT.NO_EFFECT);
  assert.match(out.reason, /incidental/i);
});

test("text change accompanied by a structural change does confirm", () => {
  const after = { ...BASE, bodyTextHash: "bbb", modalOpen: true };
  assert.equal(classifyClickOutcome({ executed: true, before: BASE, after }).result, ACTION_RESULT.CONFIRMED);
});

test("a click that could not be dispatched is ACTION_FAILED", () => {
  const out = classifyClickOutcome({ executed: false, before: BASE, after: BASE });
  assert.equal(out.result, ACTION_RESULT.FAILED);
});

test("the target disappearing counts as the site reacting", () => {
  const out = classifyClickOutcome({ executed: true, before: BASE, after: { ...BASE }, targetGone: true });
  assert.equal(out.result, ACTION_RESULT.CONFIRMED);
  assert.deepEqual(out.changes, ["targetRemoved"]);
});

test("a URL change alone confirms the click", () => {
  const after = { ...BASE, url: "https://example.com/jobs/123/apply" };
  assert.equal(classifyClickOutcome({ executed: true, before: BASE, after }).result, ACTION_RESULT.CONFIRMED);
});

test("new form fields appearing confirms the click", () => {
  const after = { ...BASE, fieldCount: 4 };
  assert.equal(classifyClickOutcome({ executed: true, before: BASE, after }).result, ACTION_RESULT.CONFIRMED);
});

test("diffPageState reports no change for identical fingerprints", () => {
  assert.equal(diffPageState(BASE, { ...BASE }).changed, false);
});

test("diffPageState is safe with missing fingerprints", () => {
  assert.equal(diffPageState(null, BASE).changed, false);
  assert.equal(diffPageState(BASE, null).changed, false);
});

// ---------------------------------------------------------------------------
// Retry strategy (Part 12 — Test 2)
// ---------------------------------------------------------------------------

test("Test 2 — a no-effect DOM click escalates to a pointer click", () => {
  const plan = nextClickStrategy(ACTION_RESULT.NO_EFFECT, 0);
  assert.equal(plan.next, "retry");
  assert.equal(plan.method, "pointer_click");
});

test("a second failure escalates to re-resolve then pointer", () => {
  const plan = nextClickStrategy(ACTION_RESULT.NO_EFFECT, 1, 4);
  assert.equal(plan.method, "reresolve_then_pointer");
});

test("a confirmed click does not retry", () => {
  assert.equal(nextClickStrategy(ACTION_RESULT.CONFIRMED, 0).next, "continue");
});

test("the retry budget is bounded and then hands back to the model", () => {
  const plan = nextClickStrategy(ACTION_RESULT.NO_EFFECT, MAX_CLICK_RETRIES - 1);
  assert.equal(plan.next, "reassess");
});

test("a stale target re-resolves rather than repeating the same click", () => {
  assert.equal(nextClickStrategy(ACTION_RESULT.STALE, 0).method, "reresolve_then_pointer");
});

// ---------------------------------------------------------------------------
// Stale elements (Part 13 — Test 3)
// ---------------------------------------------------------------------------

test("Test 3 — a detached element is reported stale", () => {
  const v = isStaleTarget({ tag: "button", text: "Easy Apply" }, { connected: false });
  assert.equal(v.stale, true);
});

test("an element whose label changed entirely is stale", () => {
  const v = isStaleTarget(
    { tag: "button", text: "Easy Apply" },
    { tag: "button", text: "Save job", connected: true, rect: { width: 10, height: 10 } },
  );
  assert.equal(v.stale, true);
});

test("a scrolled element is NOT stale — position is not identity", () => {
  const v = isStaleTarget(
    { tag: "button", text: "Easy Apply", rect: { x: 500, y: 300, width: 120, height: 40 } },
    { tag: "button", text: "Easy Apply", connected: true, rect: { x: 500, y: 40, width: 120, height: 40 } },
  );
  assert.equal(v.stale, false);
});

test("a label gaining a suffix is not treated as a different control", () => {
  const v = isStaleTarget(
    { tag: "button", text: "Next" },
    { tag: "button", text: "Next (2)", connected: true, rect: { width: 10, height: 10 } },
  );
  assert.equal(v.stale, false);
});

test("an element that lost its bounding box is stale", () => {
  const v = isStaleTarget(
    { tag: "button", text: "Easy Apply" },
    { tag: "button", text: "Easy Apply", connected: true, rect: { width: 0, height: 0 } },
  );
  assert.equal(v.stale, true);
});

test("Test 3 — a rerendered button is re-resolved to its replacement node", () => {
  const expected = {
    tag: "button", role: "button", text: "Easy Apply",
    rect: { x: 500, y: 300, width: 120, height: 40 },
  };
  const liveCandidates = [
    { id: "element_1", tag: "a", role: "link", text: "Sign in" },
    { id: "element_2", tag: "button", role: "button", text: "Easy Apply", rect: { x: 500, y: 305, width: 120, height: 40 } },
    { id: "element_3", tag: "button", role: "button", text: "Save" },
  ];
  const match = resolveLogicalTarget(expected, liveCandidates);
  assert.equal(match.id, "element_2");
});

test("re-resolution refuses a differently-labelled control", () => {
  const expected = { tag: "button", role: "button", text: "Easy Apply" };
  const candidates = [{ id: "element_9", tag: "button", role: "button", text: "Withdraw application" }];
  assert.equal(resolveLogicalTarget(expected, candidates), null);
});

test("two different unlabelled fields never re-resolve to each other", () => {
  // Nothing distinguishes two bare text inputs semantically. Guessing would
  // silently type into the wrong field, so a positional identity is required.
  const expected = { tag: "input", role: "textbox", type: "text", rect: { x: 100, y: 200, width: 200, height: 30 } };
  const elsewhere = { id: "element_2", tag: "input", role: "textbox", type: "text", rect: { x: 100, y: 320, width: 200, height: 30 } };

  assert.equal(scoreCandidateMatch(expected, elsewhere), 0);
  assert.equal(resolveLogicalTarget(expected, [elsewhere]), null);
});

test("an unlabelled field still re-resolves to its own replacement in the same position", () => {
  const expected = { tag: "input", role: "textbox", type: "text", rect: { x: 100, y: 200, width: 200, height: 30 } };
  const same = { id: "element_5", tag: "input", role: "textbox", type: "text", rect: { x: 100, y: 202, width: 200, height: 30 } };

  assert.equal(resolveLogicalTarget(expected, [same]).id, "element_5");
});

test("among identical controls, re-resolution picks the nearest, not the first", () => {
  // One "Apply" per row of a job list: re-finding the third row's Apply must
  // not land on the second row's.
  const apply = (id, y) => ({ id, tag: "a", role: "link", text: "Apply", rect: { x: 900, y, width: 60, height: 20 } });
  const expected = apply("element_3", 280);
  const match = resolveLogicalTarget(expected, [apply("element_1", 120), apply("element_2", 200), apply("element_9", 282)]);
  assert.equal(match.id, "element_9");
});

test("a named control never re-resolves to an unnamed one", () => {
  const expected = { tag: "button", role: "button", text: "Easy Apply", rect: { x: 0, y: 0, width: 100, height: 40 } };
  const unnamed = { id: "element_3", tag: "button", role: "button", text: "", rect: { x: 0, y: 0, width: 100, height: 40 } };

  assert.equal(scoreCandidateMatch(expected, unnamed), 0);
});

test("scoreCandidateMatch scores an exact match above a partial one", () => {
  const expected = { tag: "button", role: "button", text: "Submit application" };
  const exact = { tag: "button", role: "button", text: "Submit application" };
  const partial = { tag: "div", text: "Submit application now" };
  assert.ok(scoreCandidateMatch(expected, exact) > scoreCandidateMatch(expected, partial));
});

// ---------------------------------------------------------------------------
// Submission gating (Part 21)
// ---------------------------------------------------------------------------

test("submission requires evidence — a clicked Apply button is not enough", () => {
  const verdict = classifyApplicationStatus({ pageText: "Easy Apply  Save  Share" });
  assert.equal(verdict.status, APPLICATION_STATUS.UNKNOWN);
});

test("the model claiming finish yields UNKNOWN, never SUBMITTED", () => {
  const verdict = classifyApplicationStatus({ agentClaimedFinish: true, pageText: "Review your application" });
  assert.equal(verdict.status, APPLICATION_STATUS.UNKNOWN);
  assert.match(verdict.reason, /not a confirmation|no submission confirmation|rather than a confirmation/i);
});

test("mid-flow progress wording is reported as in-progress, not as silence", () => {
  const verdict = classifyApplicationStatus({ pageText: "Step 2 — Review your answers, then Next" });
  assert.equal(verdict.status, APPLICATION_STATUS.UNKNOWN);
  assert.match(verdict.reason, /in progress/i);
});

test("the platform adapter's own check is authoritative", () => {
  const verdict = classifyApplicationStatus({ adapterConfirmed: true });
  assert.equal(verdict.status, APPLICATION_STATUS.SUBMITTED);
});

test("an explicit confirmation message confirms submission", () => {
  for (const text of [
    "Your application was sent to Acme",
    "Application submitted",
    "Thank you for applying",
    "We've received your application",
  ]) {
    assert.equal(
      classifyApplicationStatus({ pageText: text }).status,
      APPLICATION_STATUS.SUBMITTED,
      `"${text}" should confirm submission`,
    );
  }
});

test("another job's status in a sidebar rail does not confirm THIS application", () => {
  // Whole-page text on a job board also contains other jobs' statuses and
  // step counters. Matching those would mark a job submitted that never was.
  for (const text of [
    "Similar jobs — Application sent 2 days ago — Software Engineer",
    "Recommended jobs / Application sent / Apply now",
    "People also viewed — Application submitted",
    "Application complete 3 of 5",
    "Easy Apply Contact info 1 of 4 Application submitted 2 of 4",
  ]) {
    assert.equal(hasSubmissionEvidence(text), false, `"${text}" must not prove submission`);
  }
});

test("a genuine confirmation banner is still recognised", () => {
  for (const text of [
    "Application submitted",
    "Your application was sent to Acme",
    "Thank you for applying",
    "We have received your application",
    "Application submitted successfully",
    "Your application is complete",
    "You have successfully applied to Python Developer",
    "Applied successfully",
  ]) {
    assert.equal(hasSubmissionEvidence(text), true, `"${text}" should prove submission`);
  }
});

test("a confirmation banner is not disqualified by an unrelated rail far below it", () => {
  const page = "Your application was sent to Acme. " + "x".repeat(400) + " Similar jobs Apply now";
  assert.equal(hasSubmissionEvidence(page), true);
});

test("progress wording is not mistaken for submission", () => {
  for (const text of ["Next", "Review", "Submit application", "Continue"]) {
    assert.equal(hasSubmissionEvidence(text), false, `"${text}" must not prove submission`);
    assert.equal(hasProgressEvidence(text), true);
  }
});

// ---------------------------------------------------------------------------
// Pointer geometry (Part 8)
// ---------------------------------------------------------------------------

test("the pointer point is the centre of the element's current rect", () => {
  const pt = pointerPointFor({ x: 500, y: 300, width: 120, height: 40 });
  assert.deepEqual(pt, { x: 560, y: 320 });
});

test("a zero-sized element has no usable pointer point", () => {
  assert.equal(pointerPointFor({ x: 0, y: 0, width: 0, height: 0 }), null);
});

test("an element outside the viewport has no usable pointer point", () => {
  const pt = pointerPointFor({ x: 0, y: 5000, width: 100, height: 40 }, { width: 1280, height: 800 });
  assert.equal(pt, null);
});

test("the pointer point is clamped inside the viewport", () => {
  const pt = pointerPointFor({ x: 1200, y: 100, width: 200, height: 40 }, { width: 1280, height: 800 });
  assert.ok(pt.x < 1280 && pt.x > 0);
});

// ---------------------------------------------------------------------------
// Security policy (Part 9 — Test 7)
// ---------------------------------------------------------------------------

test("Test 7 — a CAPTCHA frame blocks the run", () => {
  const v = detectSecurityChallenge({ frameSources: ["https://www.google.com/recaptcha/api2/bframe?x=1"] });
  assert.equal(v.blocked, true);
  assert.equal(v.kind, "captcha");
});

test("challenge wording in the page text blocks the run", () => {
  for (const text of [
    "Please verify you are human",
    "Security check required",
    "We detected unusual activity",
    "I'm not a robot",
  ]) {
    assert.equal(detectSecurityChallenge({ pageText: text }).blocked, true, `"${text}" should block`);
  }
});

test("a login wall blocks the run and asks the user to sign in", () => {
  const v = detectSecurityChallenge({ pageText: "Sign in to continue", passwordFieldVisible: true });
  assert.equal(v.blocked, true);
  assert.equal(v.kind, "login");
});

test("an ordinary application page is not blocked", () => {
  const v = detectSecurityChallenge({
    pageText: "Software Engineer at Acme. Easy Apply. Save this job.",
    frameSources: ["https://player.vimeo.com/video/1"],
  });
  assert.equal(v.blocked, false);
});

test("the blocked reason never offers to bypass the challenge", () => {
  const v = detectSecurityChallenge({ frameSources: ["https://hcaptcha.com/frame"] });
  assert.match(v.reason, /will not attempt to (solve or bypass|bypass)/i);
});

// ---------------------------------------------------------------------------
// The content-script bridge must stay in step with this module
// ---------------------------------------------------------------------------

test("the content-script bridge mirrors the interaction-core logic", async () => {
  // Content scripts are classic scripts and cannot `import`, so the logic is
  // mirrored in a bridge file. Evaluate the bridge in a bare context and
  // assert it agrees with the module on every exported behaviour, so the two
  // copies cannot silently drift.
  const bridgePath = fileURLToPath(
    new URL("../src/content/shared/interaction-core-bridge.js", import.meta.url),
  );
  const source = readFileSync(bridgePath, "utf8");
  const sandbox = {};
  new Function("globalThis", source)(sandbox);
  const bridge = sandbox.__autoApplyInteractionCore;

  assert.ok(bridge, "the bridge must publish __autoApplyInteractionCore");
  assert.deepEqual(bridge.ACTION_RESULT, ACTION_RESULT);
  assert.deepEqual(bridge.APPLICATION_STATUS, APPLICATION_STATUS);
  assert.equal(bridge.MAX_CLICK_RETRIES, MAX_CLICK_RETRIES);

  const applyEl = { tag: "button", role: "button", text: "", ariaLabel: "Easy Apply", visible: true };
  assert.equal(bridge.rankApplyIntent(applyEl), rankApplyIntent(applyEl));
  assert.equal(bridge.accessibleName(applyEl), accessibleName(applyEl));

  const after = { ...BASE, modalOpen: true };
  assert.deepEqual(bridge.diffPageState(BASE, after), diffPageState(BASE, after));
  assert.deepEqual(
    bridge.classifyClickOutcome({ executed: true, before: BASE, after: { ...BASE } }),
    classifyClickOutcome({ executed: true, before: BASE, after: { ...BASE } }),
  );
  assert.deepEqual(
    bridge.classifyApplicationStatus({ agentClaimedFinish: true }),
    classifyApplicationStatus({ agentClaimedFinish: true }),
  );
  assert.deepEqual(bridge.nextClickStrategy(ACTION_RESULT.NO_EFFECT, 0), nextClickStrategy(ACTION_RESULT.NO_EFFECT, 0));
  assert.deepEqual(
    bridge.pointerPointFor({ x: 500, y: 300, width: 120, height: 40 }),
    pointerPointFor({ x: 500, y: 300, width: 120, height: 40 }),
  );
  assert.deepEqual(
    bridge.detectSecurityChallenge({ frameSources: ["https://hcaptcha.com/x"] }),
    detectSecurityChallenge({ frameSources: ["https://hcaptcha.com/x"] }),
  );

  const expected = { tag: "button", role: "button", text: "Easy Apply" };
  const cands = [{ id: "element_2", tag: "button", role: "button", text: "Easy Apply" }];
  assert.deepEqual(bridge.resolveLogicalTarget(expected, cands), resolveLogicalTarget(expected, cands));
});
