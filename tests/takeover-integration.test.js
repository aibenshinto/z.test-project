// The driver and the page's scripts together, with only the model faked.
//
// The driver's tests fake the page and the page's tests fake the worker, so
// neither proves they agree: that an element id the page showed is one it
// can click, that a job's link comes back for the target the reading named.
// Here the real content scripts answer the real driver, on a results page
// shaped like the one the agent failed on — titles as headings, the search in
// the tab title, a promotion beside the list, job links opening new tabs.
//
// Run with: node --test tests/takeover-integration.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createEnvironment } from "./helpers/dom-harness.js";
import { runTakeover } from "../src/lib/takeover-driver.js";
import { validateReading } from "../src/lib/page-agent.js";

const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"),
);
const SCRIPTS = MANIFEST.content_scripts.flatMap((block) => block.js);

const SEARCH = "https://www.naukri.com/python-developer-jobs-in-kochi?k=python%20developer";
const TITLES = ["Python Developer", "Senior Python Developer"];
const jobUrl = (i) => `https://www.naukri.com/job-listings-python-dev-acme-${i}1809250000${i}`;

function resultsPage() {
  const e = createEnvironment({ scripts: SCRIPTS, url: SEARCH, title: "Python Developer Jobs In Kochi - Naukri.com" });
  TITLES.forEach((title, i) => {
    const y = (i + 1) * 300;
    const card = e.make("div", { class: "srp-jobtuple-wrapper", rect: { x: 220, y, width: 720, height: 270 } });
    const h2 = e.make("h2", { rect: { x: 255, y, width: 400, height: 30 } }, card);
    e.make("a", { class: "title", target: "_blank", href: `${jobUrl(i)}?src=jobsearchDesk&sid=1`, text: title,
      rect: { x: 255, y, width: 300, height: 30 } }, h2);
    e.make("span", { text: `Company ${i} · 0-2 Yrs · Bengaluru`, rect: { x: 255, y: y + 40, width: 300, height: 20 } }, card);
  });
  e.make("a", { href: "https://www.naukri.com/naukri-pro", text: "Improve your auto-apply outcomes. Get Naukri Pro",
    rect: { x: 980, y: 300, width: 130, height: 120 } });
  return e;
}

/** A job's own page: Apply opens a one-question form whose Submit confirms. */
function jobPage(i) {
  const e = createEnvironment({ scripts: SCRIPTS, url: jobUrl(i), title: `${TITLES[i]} - Company ${i} - Naukri.com` });
  e.make("h1", { text: TITLES[i], rect: { x: 0, y: 80, width: 500, height: 40 } });
  const apply = e.make("button", { id: "apply-button", text: "Apply", rect: { x: 600, y: 80, width: 120, height: 40 } });
  apply.addEventListener("click", () => {
    const dialog = e.make("div", { role: "dialog", rect: { x: 100, y: 150, width: 600, height: 400 } });
    e.make("input", { type: "text", "aria-label": "Notice period", rect: { x: 120, y: 200, width: 200, height: 30 } }, dialog);
    const submit = e.make("button", { text: "Submit", rect: { x: 120, y: 260, width: 100, height: 36 } }, dialog);
    // As most forms do, the confirmation takes the form's place.
    submit.addEventListener("click", () => {
      dialog.remove();
      e.make("h2", { text: "You have successfully applied to " + TITLES[i], rect: { x: 0, y: 40, width: 500, height: 30 } });
    });
  });
  // The form filler asks the model for each step; this one just submits.
  e.sandbox.chrome.runtime.sendMessage = async (msg) => {
    if (msg.type !== "AI_DECIDE_ACTION") return { ok: true };
    const submit = msg.snapshot.elements.find((el) => el.text === "Submit");
    return { ok: true, action: submit ? { action: "click", target: submit.id } : { action: "stop", reason: "no form" } };
  };
  return e;
}

/** Deliver a message to a page's scripts and wait for the page's reply. */
function send(e, msg) {
  return new Promise((resolve) => {
    for (const listener of e.sandbox.__messageListeners) listener(msg, {}, resolve);
  });
}

/**
 * A stand-in for the model. It reads only what the page showed it, and names
 * elements only by the ids it was given — so every id the driver acts on came
 * from the page's own view.
 */
function model(view, ctx) {
  const byText = (text) => view.elements.find((el) => el.text === text)?.id || "";
  if (view.url.startsWith(SEARCH)) {
    return {
      pageType: "job_list",
      summary: "Search results",
      jobs: view.elements.filter((el) => el.href?.startsWith("/job-listings"))
        .map((el) => ({ target: el.id, title: el.text, company: "" })),
    };
  }
  if (view.headings.some((h) => /successfully applied/.test(h))) {
    return { pageType: "application_submitted", summary: "Applied" };
  }
  if (view.dialogOpen) return { pageType: "application_form", summary: "Application form" };
  return {
    pageType: "job_detail",
    summary: view.headings[0],
    shownJob: { title: view.headings[0], company: "" },
    showsRequestedJob: !ctx.job || ctx.job.title === view.headings[0],
    applyTarget: byText("Apply"),
  };
}

test("the driver and the page agree end to end: open each job, apply, confirm", async () => {
  const tabs = new Map([[1, resultsPage()]]);
  let nextTab = 2;
  const clickedOnList = [];
  const applied = [];

  const deps = {
    view: async (tabId) => (await send(tabs.get(tabId), { type: "PAGE_VIEW" })).view,
    read: async (tabId, view, ctx) => validateReading(model(view, ctx), view),
    async act(tabId, action) {
      if (tabId === 1) clickedOnList.push(action.target);
      return tabs.get(tabId).sandbox.__autoApplyTakeover.act(action, { settleMax: 150 });
    },
    fill: (tabId, job, instruction) => send(tabs.get(tabId), { type: "FILL_APPLICATION", job, instruction }),
    verifySubmitted: async (tabId) => (await send(tabs.get(tabId), { type: "VERIFY_SUBMITTED" })).submitted,
    jobLinks: async (tabId, targets) => (await send(tabs.get(tabId), { type: "JOB_LINKS", targets })).links,
    evaluate: async () => ({ decision: "APPLY", reason: "fits" }),
    async openTab(fromTabId, url) {
      const i = [0, 1].find((n) => url.startsWith(jobUrl(n)));
      if (i == null) return null;
      const id = nextTab++;
      tabs.set(id, jobPage(i));
      return { id, url };
    },
    closeTab: async (tabId) => { tabs.delete(tabId); },
    focusTab: async () => {},
    waitForLoad: async () => {},
    tabUrl: async (tabId) => tabs.get(tabId)?.sandbox.location.href || null,
    goBack: async () => false,
    navigate: async () => {},
    applyInFrame: async () => null,
    report: () => {},
    record: (entry) => applied.push(entry.title),
    control: { stopped: () => false, waitIfPaused: async () => {} },
    sleep: async () => {},
  };

  const summary = await runTakeover(deps, { tabId: 1 });

  assert.deepEqual(applied, TITLES, summary.reason);
  assert.deepEqual(clickedOnList, [], "job links that open new tabs are opened by the worker, never clicked on the list");
  assert.deepEqual([...tabs.keys()], [1], "every job's tab is closed afterwards");
});
