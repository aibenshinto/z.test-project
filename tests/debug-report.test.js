// Tests for the debug log the side panel copies.
//
// Its point is to carry what the panel's activity box leaves out: every
// detail each event recorded, in the order things happened.
//
// Run with: node --test tests/debug-report.test.js

import test from "node:test";
import assert from "node:assert/strict";

import { buildDebugReport } from "../src/lib/debug-report.js";

// The event log is stored newest first.
const EVENTS = [
  { at: 3000, level: "warn", message: "The model is busy (gemini 429); trying again in 30 s", extra: { task: "pageRead", attempt: 1 } },
  { at: 2000, level: "info", message: "Page read", extra: { url: "https://www.naukri.com/jobs", pageType: "job_list", jobs: 20, seen: true } },
  { at: 1000, level: "info", message: "Takeover started", extra: { tabId: 7, instruction: "Apply" } },
];

test("every event is in the report, oldest first, with everything it recorded", () => {
  const report = buildDebugReport({ events: EVENTS });
  const started = report.indexOf("Takeover started");
  const read = report.indexOf("Page read");
  const busy = report.indexOf("The model is busy");
  assert.ok(started > 0 && started < read && read < busy, "in the order they happened");
  assert.match(report, /"pageType":"job_list"/, "what the model read the page as");
  assert.match(report, /"task":"pageRead","attempt":1/);
});

test("the application trace and the recent clicks are in it too", () => {
  const report = buildDebugReport({
    trace: [{ at: 1000, stage: "RECORD_SUBMIT_handler", payload: { title: "Python Developer" } }],
    interactions: [{ timestamp: 1000, action: "click", targetText: "Apply", method: "pointer_click", result: "ACTION_NO_EFFECT" }],
  });
  assert.match(report, /RECORD_SUBMIT_handler.*Python Developer/);
  assert.match(report, /click "Apply" via pointer_click → ACTION_NO_EFFECT/);
});

test("models are named by provider and model, and the run's state is given", () => {
  const report = buildDebugReport({
    routes: { default: { provider: "gemini", model: "gemini-flash-latest" } },
    run: { running: true, tabId: 7, paused: false },
    panelStatus: "read\\nReading the page",
  });
  assert.match(report, /Models: default gemini\/gemini-flash-latest/);
  assert.match(report, /Run: in progress on tab 7/);
  assert.match(report, /Panel status: read/);
});

test("an empty store still gives a readable report", () => {
  const report = buildDebugReport();
  assert.match(report, /== Activity, oldest first \(0\) ==/);
  assert.match(report, /Run: not running/);
});
