// Tests for how a model request fails and waits.
//
// A takeover run sits on a model call for every page it reads. When that call
// hung, or retried a rate limit for minutes, the panel showed only "Agent has
// taken over this page" and the run looked crashed. These pin down that every
// wait is announced, every failure says what it was, and nothing waits forever.
//
// Run with: node --test tests/llm.test.js

import test from "node:test";
import assert from "node:assert/strict";

import { askJSON, serverRetryDelay, isDailyQuota } from "../src/lib/llm/gemini.js";
import { postJSON } from "../src/lib/llm/http.js";

const DAILY_429 = JSON.stringify({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "250" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "43s" },
    ],
  },
});

const MINUTE_429 = JSON.stringify({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "10" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0s" },
    ],
  },
});

const reply = (obj, finishReason = "STOP") => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] }, finishReason }],
}), { status: 200 });

/** Replace fetch with a script of responses, one per call. */
function fakeFetch(t, responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    return typeof next === "function" ? next(init) : next;
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const ASK = { apiKey: "k", model: "gemini-test", system: "s", user: "u", schema: { type: "object" } };

test("Gemini's own retry delay is read from a 429", () => {
  assert.equal(serverRetryDelay(DAILY_429), 43000);
  assert.equal(serverRetryDelay(MINUTE_429), 0);
  assert.equal(serverRetryDelay("no delay here"), null);
});

test("a daily quota is told apart from a per-minute one", () => {
  assert.equal(isDailyQuota(DAILY_429), true);
  assert.equal(isDailyQuota(MINUTE_429), false);
});

test("a used-up daily quota fails at once, and says so", async (t) => {
  const calls = fakeFetch(t, [new Response(DAILY_429, { status: 429 })]);
  const retries = [];
  await assert.rejects(
    askJSON({ ...ASK, onRetry: (r) => retries.push(r) }),
    (err) => /daily quota/.test(err.message) && err.retryable === false,
  );
  assert.equal(calls.length, 1, "retrying a daily quota only delays the failure by minutes");
  assert.deepEqual(retries, []);
});

test("a per-minute limit is waited out as Gemini asks, and every wait is announced", async (t) => {
  fakeFetch(t, [new Response(MINUTE_429, { status: 429 }), reply({ ok: true })]);
  const retries = [];
  const { parsed } = await askJSON({ ...ASK, onRetry: (r) => retries.push(r) });
  assert.deepEqual(parsed, { ok: true });
  assert.equal(retries.length, 1);
  assert.equal(retries[0].status, 429);
  assert.equal(retries[0].waitMs, 0, "the wait Gemini named, not the default backoff");
});

test("a reply cut off before its JSON ended says why", async (t) => {
  fakeFetch(t, [reply('{"pageType": "job_li', "MAX_TOKENS")]);
  await assert.rejects(askJSON(ASK), /no usable answer \(MAX_TOKENS\)/);
});

test("a request the provider never answers times out with a message that says so", async (t) => {
  fakeFetch(t, [(init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  })]);
  await assert.rejects(
    postJSON("https://example.test/", {}, {}, 50),
    (err) => err.timeout === true && /did not answer within/.test(err.message),
  );
});
