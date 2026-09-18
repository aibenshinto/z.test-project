// Tests for the page reader — the model's account of what a page is.
//
// The reading steers the whole run, so what matters here is what it may NOT
// do: point at an element the page never showed, invent a page type, or list
// jobs off a page that is not a list.
//
// Run with: node --test tests/page-agent.test.js

import test from "node:test";
import assert from "node:assert/strict";

import {
  PAGE_SCHEMA, PAGE_TYPES, DEFAULT_INSTRUCTION,
  validateReading, buildPagePrompt, compactView, readPage,
} from "../src/lib/page-agent.js";

const view = {
  url: "https://www.naukri.com/python-developer-jobs-in-kochi?k=python",
  title: "Python Developer Jobs In Kochi - Naukri.com",
  headings: ["Python Developer", "Senior Python Developer"],
  text: "Python Developer Billions United 0-2 Yrs Bengaluru ...",
  fieldCount: 12,
  dialogOpen: false,
  elements: [
    { id: "element_1", tag: "a", role: "link", text: "Python Developer", href: "/job-listings-python-developer-1", y: 360 },
    { id: "element_2", tag: "a", role: "link", text: "Senior Python Developer", href: "/job-listings-senior-2", y: 660 },
    { id: "element_3", tag: "a", role: "link", text: "Improve your auto-apply outcomes. Get Naukri Pro", href: "/pro", y: 300 },
    { id: "element_4", tag: "a", role: "link", text: "Next", href: "/python-developer-jobs-2", y: 3000 },
  ],
};

test("the schema passes strict structured output: every property required, nothing extra", () => {
  // OpenAI's strict mode rejects a schema with optional properties, so "none"
  // is an empty string or false rather than a missing key.
  const walk = (node) => {
    if (node?.type !== "object") return;
    assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    assert.equal(node.additionalProperties, false);
    for (const child of Object.values(node.properties)) {
      walk(child);
      if (child.type === "array") walk(child.items);
    }
  };
  walk(PAGE_SCHEMA);
  assert.deepEqual(PAGE_SCHEMA.properties.pageType.enum, PAGE_TYPES);
});

test("a reading keeps the jobs the model found, each by an element the page showed", () => {
  const reading = validateReading({
    pageType: "job_list",
    summary: "Search results for python developer",
    jobs: [
      { target: "element_1", title: "Python Developer", company: "Billions United" },
      { target: "element_2", title: "Senior Python Developer", company: "Acme" },
    ],
    nextPageTarget: "element_4",
  }, view);

  assert.equal(reading.pageType, "job_list");
  assert.deepEqual(reading.jobs.map((j) => j.target), ["element_1", "element_2"]);
  assert.equal(reading.nextPageTarget, "element_4");
});

test("an element the page never showed cannot be targeted", () => {
  const reading = validateReading({
    pageType: "job_detail",
    applyTarget: "element_99",
    jobs: [{ target: "#apply-button", title: "x", company: "" }],
  }, view);

  assert.equal(reading.applyTarget, "", "an unknown id is dropped, not passed on to be clicked");
  assert.deepEqual(reading.jobs, [], "a job_detail page lists no jobs");
});

test("jobs are only ever read off a list, once each", () => {
  const listed = validateReading({
    pageType: "job_list",
    jobs: [
      { target: "element_1", title: "Python Developer", company: "" },
      { target: "element_1", title: "Python Developer (again)", company: "" },
      { target: "element_2", title: "", company: "" },
    ],
  }, view);
  assert.equal(listed.jobs.length, 1, "a repeated target counts once, an untitled one not at all");

  const detail = validateReading({
    pageType: "job_detail",
    jobs: [{ target: "element_1", title: "Python Developer", company: "" }],
    nextPageTarget: "element_4",
  }, view);
  assert.deepEqual(detail.jobs, []);
  assert.equal(detail.nextPageTarget, "", "only a list has a next page");
});

test("an unrecognised page type is 'other', never a guess at something actionable", () => {
  assert.equal(validateReading({ pageType: "applied!!" }, view).pageType, "other");
  assert.equal(validateReading(null, view).pageType, "other");
  assert.equal(validateReading("job_list", view).pageType, "other");
});

test("yes/no fields must be an explicit true", () => {
  const reading = validateReading({ pageType: "job_detail", showsRequestedJob: "true", alreadyApplied: 1 }, view);
  assert.equal(reading.showsRequestedJob, false);
  assert.equal(reading.alreadyApplied, false);
});

test("a step toward the instruction is only taken from a page that is neither list nor job", () => {
  assert.equal(validateReading({ pageType: "other", towardGoalTarget: "element_3" }, view).towardGoalTarget, "element_3");
  assert.equal(validateReading({ pageType: "job_list", towardGoalTarget: "element_3" }, view).towardGoalTarget, "");
});

test("the prompt carries the user's instruction, the job in hand, and the last step", () => {
  const prompt = buildPagePrompt(view, {
    instruction: "Apply only to remote Django jobs",
    job: { title: "Python Developer", company: "Billions United" },
    lastStep: "Clicked element_1 to open the job.",
  });
  assert.match(prompt, /Apply only to remote Django jobs/);
  assert.match(prompt, /"title":"Python Developer"/);
  assert.match(prompt, /Clicked element_1/);
  assert.match(buildPagePrompt(view, {}), new RegExp(DEFAULT_INSTRUCTION.replace(/[.]/g, "\\.")));
});

test("the model sees each element's link, so it can tell a job from a promotion", () => {
  const compact = compactView(view);
  assert.equal(compact.elements[0].href, "/job-listings-python-developer-1");
  assert.equal(compact.elements[2].href, "/pro");
  assert.equal(compact.elements[0].role, "link");
});

test("reading a page asks the model once, with the screenshot, and validates the answer", async () => {
  const calls = [];
  const askJSON = async (req) => {
    calls.push(req);
    return { pageType: "job_list", summary: "Results", jobs: [{ target: "element_1", title: "Python Developer", company: "" }] };
  };
  const reading = await readPage(view, { instruction: "Apply" }, askJSON, { screenshot: { mime: "image/png", b64: "AAAA" } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, "pageRead");
  assert.equal(calls[0].schema, PAGE_SCHEMA);
  assert.deepEqual(calls[0].file, { mime: "image/png", b64: "AAAA" });
  assert.match(calls[0].user, /screenshot/i);
  assert.equal(reading.jobs.length, 1);
});
