// Tests for the few board-specific facts the agent still needs.
//
// Run with: node --test tests/platforms.test.js

import test from "node:test";
import assert from "node:assert/strict";

import { isApplicationReceiptUrl } from "../src/lib/boards.js";

// ---------------------------------------------------------------------------
// Apply receipts
// ---------------------------------------------------------------------------

test("Naukri's external-apply receipt is recognised, so the agent does not try to apply on it", () => {
  // What "Apply on company site" leaves in the tab it was clicked in, while
  // the application itself opens elsewhere.
  assert.equal(isApplicationReceiptUrl(
    "https://www.naukri.com/myapply/showAcp?jquery=1&file=301025501137&multiApplyResp={%22301025501137%22:202}",
  ), true);
  assert.equal(isApplicationReceiptUrl("https://www.naukri.com/myapply/showAcp?file=123"), true);
});

test("a real job or application page is never taken for a receipt", () => {
  assert.equal(isApplicationReceiptUrl("https://www.naukri.com/job-listings-python-developer-acme-1"), false);
  assert.equal(isApplicationReceiptUrl("https://acme.test/jr-python-developer/"), false);
  assert.equal(isApplicationReceiptUrl("https://www.linkedin.com/jobs/view/1"), false);
  assert.equal(isApplicationReceiptUrl(""), false);
  assert.equal(isApplicationReceiptUrl(undefined), false);
});

test("Naukri's own apply confirmation is not a receipt: the adapter reads it as proof of submission", () => {
  // `saveApply` means an application on Naukri itself went through, which the
  // Naukri adapter checks for. Only the external-apply page is bookkeeping.
  assert.equal(isApplicationReceiptUrl("https://www.naukri.com/myapply/saveApply?file=123"), false);
});
