// Tests for choosing which frame of a page holds the application.
//
// Run with: node --test tests/frames.test.js

import test from "node:test";
import assert from "node:assert/strict";

import { pickApplicationFrame } from "../src/lib/frames.js";

const page = { frameId: 0, url: "https://acme.test/careers/1", state: "unknown", fields: 1 };

test("an embedded application form is found", () => {
  // The shape of a company careers page that embeds Greenhouse.
  const frame = pickApplicationFrame([
    page,
    { frameId: 3, url: "https://boards.greenhouse.io/embed/job_app?token=1", state: "applying", fields: 9 },
  ]);

  assert.equal(frame.frameId, 3);
});

test("a page with no embedded application says so", () => {
  assert.equal(pickApplicationFrame([page]), null);
  assert.equal(pickApplicationFrame([]), null);
  assert.equal(pickApplicationFrame(null), null);
});

test("an ad, a tracker or a chat widget is never the application", () => {
  const frame = pickApplicationFrame([
    page,
    { frameId: 1, url: "https://doubleclick.test/ad", state: "unknown", fields: 0 },
    { frameId: 2, url: "https://chat.test/widget", state: "unknown", fields: 2 },
    { frameId: 4, url: "about:blank", state: "ready", fields: 0 },
    { frameId: 5, url: "javascript:void(0)", state: "applying", fields: 8 },
  ]);

  assert.equal(frame, null, "only an http(s) frame showing an application counts");
});

test("the page itself is never chosen, however it looks", () => {
  // If the application were in the page, the agent would not be asking.
  assert.equal(pickApplicationFrame([{ ...page, state: "applying", fields: 12 }]), null);
});

test("an application already open beats one merely offered", () => {
  const frame = pickApplicationFrame([
    page,
    { frameId: 2, url: "https://jobs.lever.co/acme/1", state: "ready", fields: 20 },
    { frameId: 3, url: "https://boards.greenhouse.io/embed/job_app", state: "applying", fields: 4 },
  ]);

  assert.equal(frame.frameId, 3, "an open form beats a bigger page that only offers one");
});

test("between two of a kind, the one with more of a form in it", () => {
  const frame = pickApplicationFrame([
    page,
    { frameId: 2, url: "https://acme.test/newsletter", state: "ready", fields: 2 },
    { frameId: 3, url: "https://boards.greenhouse.io/embed/job_app", state: "ready", fields: 11 },
  ]);

  assert.equal(frame.frameId, 3);
});
