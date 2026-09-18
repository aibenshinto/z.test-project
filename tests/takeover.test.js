// Tests for the page's half of a takeover — the agent's eyes and hands.
//
// The run lives in the worker (tests/takeover-driver.test.js). What the page
// owes it is an honest description of itself and faithful execution of one
// action at a time. It must not decide what the page is: rules for that used
// to "open" jobs on a search page by finding the search words in its
// headings, and then look for Apply on the results list.
//
// Run with: node --test tests/takeover.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createEnvironment } from "./helpers/dom-harness.js";

const MANIFEST = JSON.parse(
  readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8"),
);

/** Every script Chrome injects into a page on this host, in manifest order. */
function scriptsFor(hostname) {
  const files = [];
  for (const block of MANIFEST.content_scripts) {
    const matched = block.matches.some((pattern) => {
      const m = /^https?:\/\/([^/]+)\//.exec(pattern);
      if (!m) return false;
      const host = m[1];
      if (host === "*") return true;
      if (host.startsWith("*.")) {
        const base = host.slice(2);
        return hostname === base || hostname.endsWith("." + base);
      }
      return hostname === host;
    });
    if (matched) files.push(...block.js);
  }
  return files;
}

/**
 * A search results page shaped like Naukri's: the titles are headings, the
 * tab title repeats the search, and a promotion sits beside the list.
 */
function resultsPage() {
  const e = createEnvironment({
    scripts: scriptsFor("www.naukri.com"),
    url: "https://www.naukri.com/python-developer-jobs-in-kochi?k=python%20developer",
    title: "Python Developer Jobs In Kochi - Naukri.com",
  });
  const titles = ["Python Developer", "Senior Python Developer", "Python Django Developer"];
  const jobs = titles.map((title, i) => {
    const y = (i + 1) * 300;
    const card = e.make("div", { class: "srp-jobtuple-wrapper", rect: { x: 220, y, width: 720, height: 270 } });
    const h2 = e.make("h2", { rect: { x: 255, y, width: 400, height: 30 } }, card);
    const link = e.make("a", {
      class: "title", target: "_blank",
      href: `https://www.naukri.com/job-listings-python-dev-acme-${i}18092500${i}?src=jobsearchDesk&sid=123&xp=${i}`,
      text: title, rect: { x: 255, y, width: 300, height: 30 },
    }, h2);
    e.make("span", { text: `Company ${i}`, rect: { x: 255, y: y + 40, width: 200, height: 20 } }, card);
    e.make("span", { text: `${i}-${i + 3} Yrs · Bengaluru`, rect: { x: 255, y: y + 70, width: 200, height: 20 } }, card);
    return { card, link, title };
  });
  const promo = e.make("a", {
    href: "https://www.naukri.com/naukri-pro", text: "Improve your auto-apply outcomes. Get Naukri Pro",
    rect: { x: 980, y: 300, width: 130, height: 120 },
  });
  return { e, jobs, promo };
}

/** Deliver a message to every listener the scripts registered. */
function deliver(e, msg) {
  const replies = [];
  let keptChannel = false;
  for (const listener of e.sandbox.__messageListeners) {
    if (listener(msg, {}, (reply) => replies.push(reply))) keptChannel = true;
  }
  return { replies, keptChannel };
}

/** Send a message and wait for the page's one reply. */
async function ask(e, msg) {
  let resolve;
  const answered = new Promise((r) => { resolve = r; });
  for (const listener of e.sandbox.__messageListeners) listener(msg, {}, resolve);
  return answered;
}

const idOf = (view, text) => view.elements.find((el) => el.text === text)?.id;

// ---------------------------------------------------------------------------
// Describing the page
// ---------------------------------------------------------------------------

test("the page describes itself and leaves deciding what it is to the model", async () => {
  const { e } = resultsPage();
  const { ok, view } = await ask(e, { type: "PAGE_VIEW" });

  assert.equal(ok, true);
  assert.equal(view.title, "Python Developer Jobs In Kochi - Naukri.com");
  assert.deepEqual(view.headings, ["Python Developer", "Senior Python Developer", "Python Django Developer"]);
  // Everything is there for the model to judge — the promotion included.
  for (const text of ["Python Developer", "Senior Python Developer", "Improve your auto-apply outcomes. Get Naukri Pro"]) {
    assert.ok(idOf(view, text), `"${text}" must be shown to the model`);
  }
  // And nothing in it is a verdict.
  for (const verdict of ["pageType", "applicationState", "jobs", "applyCandidates"]) {
    assert.equal(verdict in view, false, `the view must not carry a "${verdict}" of its own`);
  }
});

test("each link in the view carries where it leads, short", async () => {
  const { e } = resultsPage();
  const { view } = await ask(e, { type: "PAGE_VIEW" });

  const job = view.elements.find((el) => el.text === "Python Developer");
  assert.match(job.href, /^\/job-listings-python-dev-acme-/);
  assert.equal(view.elements.find((el) => el.text.startsWith("Improve")).href, "/naukri-pro");
});

test("a security challenge is reported by the page itself, before any model sees it", async () => {
  const { e } = resultsPage();
  e.make("iframe", { src: "https://www.google.com/recaptcha/api2/bframe?k=x", rect: { x: 0, y: 0, width: 300, height: 400 } });
  const { view } = await ask(e, { type: "PAGE_VIEW" });
  assert.match(view.blocked, /captcha|verification|security/i);
});

test("a page with more elements than the model is shown keeps the ones on screen", () => {
  const e = createEnvironment({ scripts: scriptsFor("acme.test"), url: "https://acme.test/jobs" });
  for (let i = 0; i < 260; i++) {
    e.make("a", { href: `/jobs/${i}`, text: `Opening number ${i}`, rect: { x: 0, y: i * 60, width: 300, height: 30 } });
  }
  const view = e.sandbox.__autoApplyTakeover.pageView();

  assert.equal(view.elements.length, 200);
  assert.equal(view.elements[0].text, "Opening number 0", "the top of the page is kept, in page order");
});

// ---------------------------------------------------------------------------
// The jobs the model found
// ---------------------------------------------------------------------------

test("for each job the model names, the page says where it leads and what its card says", async () => {
  const { e } = resultsPage();
  const { view } = await ask(e, { type: "PAGE_VIEW" });
  const targets = ["Python Developer", "Senior Python Developer"].map((t) => idOf(view, t));

  const { links } = await ask(e, { type: "JOB_LINKS", targets });

  assert.equal(links.length, 2);
  assert.match(links[0].url, /job-listings-python-dev-acme-0/);
  assert.equal(links[0].newTab, true, "a target=_blank link is opened by the worker, not clicked");
  assert.ok(!/src=|sid=/.test(links[0].key), "tracking parameters are not part of a job's identity");
  assert.match(links[0].text, /Company 0/);
  assert.match(links[0].text, /0-3 Yrs/);
  assert.ok(!/Company 1/.test(links[0].text), "a card holds its own job, not its neighbour's");
});

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

test("an action on an element the model named is performed and verified", async () => {
  const { e } = resultsPage();
  const btn = e.make("button", { text: "Easy Apply", rect: { x: 500, y: 100, width: 120, height: 40 } });
  btn.addEventListener("click", () => e.make("div", { role: "dialog", rect: { x: 100, y: 100, width: 600, height: 400 } }));

  const view = e.sandbox.__autoApplyTakeover.pageView();
  const result = await e.sandbox.__autoApplyTakeover.act(
    { action: "click", target: idOf(view, "Easy Apply") }, { settleMax: 200 });

  assert.equal(result.result, "ACTION_CONFIRMED");
});

test("an action the page ignores is reported as such, not as done", async () => {
  const { e } = resultsPage();
  e.make("button", { text: "Easy Apply", rect: { x: 500, y: 100, width: 120, height: 40 } });

  const view = e.sandbox.__autoApplyTakeover.pageView();
  const result = await e.sandbox.__autoApplyTakeover.act(
    { action: "click", target: idOf(view, "Easy Apply") }, { settleMax: 150 });

  assert.notEqual(result.result, "ACTION_CONFIRMED");
});

test("filling runs the shared agent loop, with the user's instruction", async () => {
  const e = createEnvironment({ scripts: scriptsFor("acme.test"), url: "https://acme.test/apply" });
  const form = e.make("form", { rect: { width: 600, height: 400 } });
  e.make("input", { type: "file", "aria-label": "Resume", rect: { width: 200, height: 30 } }, form);

  const asked = [];
  e.sandbox.chrome.runtime.sendMessage = async (msg) => {
    asked.push(msg);
    return msg.type === "AI_DECIDE_ACTION" ? { ok: true, action: { action: "stop", reason: "end of test" } } : { ok: true };
  };

  const outcome = await ask(e, { type: "FILL_APPLICATION", job: { title: "Python Developer" }, instruction: "Notice period is 30 days" });

  assert.equal(outcome.submitted, false);
  const decide = asked.find((m) => m.type === "AI_DECIDE_ACTION");
  assert.equal(decide.instruction, "Notice period is 30 days");
  assert.equal(decide.job.title, "Python Developer");
});

test("a page with no field of its own but a frame asks for the frame first", async () => {
  // A careers page embeds its ATS; the fields are in the frame.
  const e = createEnvironment({ scripts: scriptsFor("acme.test"), url: "https://acme.test/careers/1" });
  e.make("h1", { text: "Senior Python Developer", rect: { width: 400, height: 40 } });
  e.make("iframe", { src: "https://boards.greenhouse.io/embed/job_app?for=acme", rect: { width: 800, height: 900 } });

  assert.deepEqual(await ask(e, { type: "FILL_APPLICATION", job: { title: "x" } }), { noForm: true });
});

test("confirmation is checked against the page's own words", async () => {
  const e = createEnvironment({ scripts: scriptsFor("acme.test"), url: "https://acme.test/apply/done" });
  assert.equal((await ask(e, { type: "VERIFY_SUBMITTED" })).submitted, false);
  e.make("h1", { text: "Application submitted", rect: { width: 400, height: 30 } });
  assert.equal((await ask(e, { type: "VERIFY_SUBMITTED" })).submitted, true);
});

test("the page script has no run of its own to lose when the page navigates", () => {
  const t = createEnvironment({ scripts: scriptsFor("acme.test"), url: "https://acme.test/" }).sandbox.__autoApplyTakeover;
  for (const gone of ["run", "applyToOpenJob", "jobIsOpen", "onResultsPage", "returnToResults"]) {
    assert.equal(t[gone], undefined, `${gone} belongs to the worker's run, or to nobody`);
  }
});

test("one adapter reads every site, job board or company careers page", () => {
  for (const hostname of [
    "www.naukri.com", "www.linkedin.com", "in.indeed.com",
    "boards.greenhouse.io", "jobs.lever.co", "careers.acme.test",
  ]) {
    const e = createEnvironment({ scripts: scriptsFor(hostname), url: `https://${hostname}/x` });
    assert.equal(e.sandbox.genericAgentLoop.adapter.name, "generic",
      `${hostname} must be readable without a bundle of its own`);
  }
});

test("the agent never opens or closes tabs from the content script", () => {
  // Tab control belongs to the worker, which validates it. A content script
  // that could open tabs would let a page-level bug spawn windows.
  const source = readFileSync(
    fileURLToPath(new URL("../src/content/shared/takeover.js", import.meta.url)), "utf8",
  );
  assert.ok(!/chrome\.tabs\./.test(source), "takeover.js must not call chrome.tabs directly");
  assert.ok(!/window\.open\(/.test(source), "takeover.js must not call window.open");
});

// ---------------------------------------------------------------------------
// The visible cursor
// ---------------------------------------------------------------------------

test("the cursor overlay never intercepts clicks meant for the page", async () => {
  const { e } = resultsPage();
  await e.sandbox.__autoApplyCursor.moveTo(100, 100);

  const root = e.document.querySelector("#__aa_cursor_root__");
  assert.ok(root, "the overlay must exist once used");
  // pointer-events:none is what keeps it from stealing clicks.
  assert.match(
    e.document.querySelector("#__aa_cursor_style__").textContent,
    /pointer-events:\s*none/,
  );
});

test("the cursor can be turned off and leaves no overlay behind", () => {
  const { e } = resultsPage();
  e.sandbox.__autoApplyCursor.setEnabled(false);
  assert.equal(e.sandbox.__autoApplyCursor.isEnabled(), false);

  e.sandbox.__autoApplyCursor.destroy();
  assert.equal(e.document.querySelector("#__aa_cursor_root__"), null);
});

test("a cursor the user turned off stays off while the agent reads the page", async () => {
  const { e } = resultsPage();
  e.sandbox.__autoApplyCursor.setEnabled(false);
  await ask(e, { type: "PAGE_VIEW" });
  assert.equal(e.sandbox.__autoApplyCursor.isEnabled(), false);
});

test("a broken cursor overlay never breaks an interaction", async () => {
  const { e } = resultsPage();
  const btn = e.make("button", { text: "Easy Apply", rect: { x: 0, y: 0, width: 120, height: 40 } });
  btn.addEventListener("click", () => e.make("div", { role: "dialog", rect: { width: 300, height: 200 } }));

  // Simulate the overlay throwing on every call.
  e.sandbox.__autoApplyCursor.moveTo = () => { throw new Error("overlay exploded"); };
  e.sandbox.__autoApplyCursor.flashClick = () => { throw new Error("overlay exploded"); };

  const id = e.sandbox.__autoApplyObserverCore.buildSnapshot({}).elements
    .find((x) => x.text === "Easy Apply").id;
  const result = await e.sandbox.__autoApplyExecutorCore.click(id, { settleMax: 400 });

  assert.equal(result.result, "ACTION_CONFIRMED", "the click must succeed despite the overlay failing");
});

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

test("a message to the page is answered by the page, not by a frame inside it", () => {
  // Every frame of a tab runs these scripts and sees every message sent to
  // that tab, and the first reply wins. An embedded ad answering "describe
  // this page" would have the model read the ad.
  const url = "https://acme.test/careers/1";
  const top = createEnvironment({ scripts: scriptsFor("acme.test"), url });
  const frame = createEnvironment({ scripts: scriptsFor("acme.test"), url, frame: true });

  assert.equal(deliver(top, { type: "TAKEOVER_PROBE" }).replies.length, 1);
  assert.equal(deliver(frame, { type: "TAKEOVER_PROBE" }).replies.length, 0,
    "a frame must leave the page's messages to the page");
});

test("a message addressed to a frame is answered by that frame, not by the page", () => {
  const url = "https://acme.test/careers/1";
  const top = createEnvironment({ scripts: scriptsFor("acme.test"), url });
  const frame = createEnvironment({ scripts: scriptsFor("acme.test"), url, frame: true });
  const addressed = { type: "FILL_APPLICATION", toFrame: true, force: true, job: { title: "Python Developer" } };

  assert.equal(deliver(top, addressed).keptChannel, false,
    "the page must not answer for one of its frames");
  assert.equal(deliver(frame, addressed).keptChannel, true);
});

test("hiding the agent cursor hides it in embedded frames too", () => {
  // The cursor is drawn by each frame in its own document, so a frame that
  // ignored this would keep drawing one after the user turned it off.
  const url = "https://acme.test/careers/1";
  const top = createEnvironment({ scripts: scriptsFor("acme.test"), url });
  const frame = createEnvironment({ scripts: scriptsFor("acme.test"), url, frame: true });
  const hide = { type: "SET_CURSOR_VISIBLE", visible: false };

  assert.equal(frame.sandbox.__autoApplyCursor.isEnabled(), true, "on by default");

  deliver(top, hide);
  const framed = deliver(frame, hide);

  assert.equal(top.sandbox.__autoApplyCursor.isEnabled(), false);
  assert.equal(frame.sandbox.__autoApplyCursor.isEnabled(), false,
    "an embedded frame draws its own cursor and must hide it too");

  // The panel still gets exactly one answer, from the page.
  assert.equal(deliver(top, hide).replies.length, 1);
  assert.equal(framed.replies.length, 0);
});
