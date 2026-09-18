// The worker's half of a takeover: the browser access the driver needs, and
// the run's controls.
//
// The run lives here, not in the page, so a page that navigates — which is
// what Apply does on most job boards — no longer ends it. The page's scripts
// are addressed one request at a time; when a page goes away mid-request,
// that is read as "it navigated" and the driver reads the next page.
//
// Only one run at a time, held in module scope. That is the one piece of
// state here that does not survive the worker being evicted, so the worker is
// kept awake while a run is in progress.

import { runTakeover } from "../lib/takeover-driver.js";
import { readPage } from "../lib/page-agent.js";
import { ACTION_RESULT } from "../lib/interaction-core.js";

let active = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function takeoverStatus() {
  return active
    ? { running: true, tabId: active.tabId, paused: active.paused }
    : { running: false };
}

export function stopTakeover() {
  if (!active) return false;
  active.stop = true;
  active.paused = false;
  return true;
}

export function pauseTakeover() {
  if (active) active.paused = true;
  return Boolean(active);
}

export function resumeTakeover() {
  if (active) active.paused = false;
  return Boolean(active);
}

/**
 * Run a takeover of `opts.tabId` to its end.
 *
 * @param {object} opts      { tabId, instruction, maxJobs, maxPages }
 * @param {object} services  Worker functions the run needs — see browserDeps
 * @returns {Promise<object>} the run's summary
 */
export async function startTakeover(opts, services) {
  if (active) return { ok: false, error: "a takeover run is already in progress" };
  const control = { tabId: opts.tabId, stop: false, paused: false };
  active = control;

  // An idle worker is evicted after ~30s, and a run spends longer than that
  // waiting on a model or a slow page. Any extension call resets the timer.
  const keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);

  try {
    return await runTakeover(browserDeps(control, services), opts);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearInterval(keepAlive);
    active = null;
  }
}

/**
 * The driver's view of the browser.
 *
 * @param {object} control
 * @param {object} s  services from the worker:
 *   askJSON, captureForModel, evaluateJob, recordApplied, tabOpenedBy,
 *   rememberOpenedTab, applyInFrame, waitForTab, safeHttpUrl, info
 */
function browserDeps(control, s) {
  // The page itself answers, never a frame inside it.
  const send = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  const tabInfo = (tab) => ({ id: tab.id, url: tab.pendingUrl || tab.url || "" });

  return {
    async view(tabId) {
      try {
        const res = await send(tabId, { type: "PAGE_VIEW" });
        return res?.ok ? res.view : null;
      } catch (_) {
        // Still loading, or a page the extension cannot run on.
        return null;
      }
    },

    async read(tabId, view, ctx) {
      // The model sees the page as well as its description, when the page
      // is the one on screen: a tab can only be captured while it is shown.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const screenshot = tab?.active ? await s.captureForModel(tab.windowId).catch(() => null) : null;
      const reading = await readPage(view, ctx, s.askJSON, { screenshot });
      await s.info("Page read", {
        url: view.url,
        pageType: reading.pageType,
        jobs: reading.jobs.length,
        summary: reading.summary,
        seen: Boolean(screenshot),
      });
      return reading;
    },

    async act(tabId, action) {
      const since = Date.now();
      let r;
      try {
        r = await send(tabId, { type: "PAGE_ACT", action });
      } catch (_) {
        // The page unloaded under the click: it navigated, and perhaps opened
        // a tab as it went.
        const opened = await s.tabOpenedBy(tabId, since, 1500);
        if (opened) return { result: ACTION_RESULT.CONFIRMED, openedTab: tabInfo(opened) };
        return { result: ACTION_RESULT.CONFIRMED, navigated: true };
      }
      if (!r) return { result: ACTION_RESULT.FAILED, error: "the page did not answer" };
      if (r.openedTab) return r;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status === "loading") return { ...r, result: ACTION_RESULT.CONFIRMED, navigated: true };
      return r;
    },

    async fill(tabId, job, instruction, opts = {}) {
      const since = Date.now();
      try {
        const outcome = await send(tabId, {
          type: "FILL_APPLICATION", job, instruction, force: Boolean(opts.force),
        });
        return outcome || { submitted: false, reason: "the page did not answer" };
      } catch (_) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) return { submitted: false, reason: "the application tab was closed" };
        const opened = await s.tabOpenedBy(tabId, since, 1500);
        if (opened) return { newTab: tabInfo(opened) };
        await s.waitForTab(tabId).catch(() => {});
        return { navigated: true };
      }
    },

    async verifySubmitted(tabId) {
      try {
        return Boolean((await send(tabId, { type: "VERIFY_SUBMITTED" }))?.submitted);
      } catch (_) {
        return false;
      }
    },

    async jobLinks(tabId, targets) {
      try {
        return (await send(tabId, { type: "JOB_LINKS", targets }))?.links || [];
      } catch (_) {
        return [];
      }
    },

    evaluate: (job) => s.evaluateJob(job),

    async openTab(fromTabId, url, { pointAt } = {}) {
      const safe = s.safeHttpUrl(url);
      if (!safe) return null;
      if (pointAt) await send(fromTabId, { type: "POINT_AT", target: pointAt }).catch(() => {});
      const from = await chrome.tabs.get(fromTabId).catch(() => null);
      const tab = await chrome.tabs.create({
        url: safe, active: true, openerTabId: fromTabId,
        ...(from ? { index: from.index + 1 } : {}),
      });
      s.rememberOpenedTab(tab.id, fromTabId);
      return { id: tab.id, url: safe };
    },

    closeTab: (tabId) => chrome.tabs.remove(tabId).catch(() => {}),
    focusTab: (tabId) => chrome.tabs.update(tabId, { active: true }).catch(() => {}),

    async waitForLoad(tabId) {
      await s.waitForTab(tabId).catch(() => {});
    },

    async tabUrl(tabId) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      return tab ? (tab.url || tab.pendingUrl || null) : null;
    },

    async goBack(tabId) {
      try {
        await chrome.tabs.goBack(tabId);
        return true;
      } catch (_) {
        return false;
      }
    },

    navigate: (tabId, url) => chrome.tabs.update(tabId, { url }).catch(() => {}),

    applyInFrame: (tabId, job, instruction) => s.applyInFrame(tabId, job, instruction),

    report(event) {
      chrome.runtime.sendMessage({ type: "TAKEOVER_PROGRESS", ...event }).catch(() => {});
      if (event.tabId != null) {
        send(event.tabId, { type: "CURSOR_NOTE", note: event.note || "" }).catch(() => {});
      }
    },

    record: (entry) => s.recordApplied(entry),

    control: {
      stopped: () => control.stop,
      async waitIfPaused() {
        while (control.paused && !control.stop) await sleep(500);
      },
    },

    sleep,

    async done(tabId) {
      if (tabId != null) await send(tabId, { type: "CURSOR_NOTE", note: "" }).catch(() => {});
    },
  };
}
