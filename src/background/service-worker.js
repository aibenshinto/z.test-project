// Orchestrator.
//
// The agent runs in the tab the user is watching: they search, press "Take
// over", and the content scripts work down that page. The worker is not a run
// loop — it is the privileged half of that session. It does the things a
// content script cannot: talk to a model, hold the API keys, read the profile
// and resume, and see across tabs.
//
// There is no background queue and no hidden tab. An earlier version scraped a
// search into a stored queue and applied in tabs the user never saw; it only
// ever worked on two job boards, because a queue needs a per-site scraper and
// a per-site apply message. Walking whatever results page the user is already
// on needs neither, which is what makes the agent work on any job board.
//
// The worker is evicted after ~30s idle, so nothing that must survive lives in
// module scope. The one exception is the record of which tab opened which,
// which is only meaningful while a run is in progress and messaging the worker
// constantly.

import { getSettings, deleteAllUserData } from "../lib/storage.js";
import { canSubmit, recordSubmit, halt, clearHalt, stats } from "./governor.js";
import { resolve as resolveAnswer } from "../lib/answer-bank.js";
import { getResume, getProfile, parseResume, storeResume } from "../lib/resume.js";
import { evaluateJobWithModel } from "../lib/evaluator.js";
import { askJSON } from "../lib/llm/index.js";
import { info, warn, getLog } from "../lib/logger.js";
import { isApplicationReceiptUrl } from "../lib/boards.js";
import { pickApplicationFrame } from "../lib/frames.js";
import { profileHintForQuestion } from "../lib/questions.js";
import { decideAction } from "../lib/ui-agent.js";
import {
  isDebugEnabled, setDebugEnabled, recordDiagnostic, getDiagnostics,
  clearDiagnostics, captureViewport, captureForModel, storeFailureCapture, getCaptures,
} from "../lib/debug-store.js";

async function persistApplyTrace(entry) {
  const { applyTrace = [] } = await chrome.storage.local.get("applyTrace");
  applyTrace.push({
    at: Date.now(),
    ...entry
  });
  await chrome.storage.local.set({
    applyTrace: applyTrace.slice(-100)
  });
}

/**
 * Accept only http(s) URLs for agent-requested navigation.
 * A `javascript:` or `data:` URL would be code execution by another name.
 */
function safeHttpUrl(raw) {
  try {
    const url = new URL(String(raw));
    return (url.protocol === "https:" || url.protocol === "http:") ? url.href : null;
  } catch (_) {
    return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// ---- Tabs opened by pages ---------------------------------------------------
//
// A click on a target=_blank link changes nothing on the page that was
// clicked, so a content script cannot tell it worked. This records which tab
// opened which, and when, so the page can ask. Kept in memory only: a takeover
// run messages the worker constantly, so it is not evicted mid-run.

/** tabId → { id, openerTabId, createdAt } */
const openedTabs = new Map();

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) return;
  openedTabs.set(tab.id, { id: tab.id, openerTabId: tab.openerTabId, createdAt: Date.now() });
});
chrome.tabs.onRemoved.addListener((tabId) => openedTabs.delete(tabId));

/**
 * The most recent still-open tab that `openerTabId` opened at or after
 * `since`, waiting up to `waitMs` for its creation event to arrive.
 *
 * One click can open two tabs: an apply control can open the company's own
 * application and, alongside it, the board's record of the click. The receipt
 * is never the application, so it is passed over while any other candidate
 * exists — and taken only when it is the only thing that opened, so the caller
 * can say what happened.
 */
async function tabOpenedBy(openerTabId, since, waitMs = 0) {
  const deadline = Date.now() + Math.min(Number(waitMs) || 0, 5000);
  for (;;) {
    const candidates = [...openedTabs.values()]
      .filter((t) => t.openerTabId === openerTabId && t.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt);

    let receipt = null;
    for (const { id } of candidates) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab) {
        openedTabs.delete(id);
        continue;
      }
      if (isApplicationReceiptUrl(tab.pendingUrl || tab.url || "")) {
        receipt = receipt || tab;
        continue;
      }
      return tab;
    }
    if (Date.now() >= deadline) return receipt;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Close a job board's receipt page once it has loaded and recorded the click.
 * Failing to close it is not worth failing an application over.
 */
async function closeReceiptTab(tabId) {
  await waitForTab(tabId).catch(() => {});
  await chrome.tabs.remove(tabId).catch(() => {});
}

/**
 * Only a tab that the asking page itself opened may be adopted or closed.
 * The record taken at creation counts too: Chrome can clear a tab's live
 * `openerTabId` once the user switches tabs.
 */
async function childTab(openerTabId, tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab) return null;
  const opener = openedTabs.get(tab.id)?.openerTabId ?? tab.openerTabId;
  return opener === openerTabId ? tab : null;
}

function waitForTab(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t) return reject(new Error("tab closed"));
      if (t.status === "complete") return resolve();
      if (Date.now() > deadline) return reject(new Error("tab load timeout"));
      setTimeout(poll, 250);
    };
    poll();
  });
}

/**
 * Run the takeover application in `tabId` and return its outcome, following
 * the application across page loads.
 *
 * Apply on a job board often sends the same tab on to the company's own site.
 * That unloads the page mid-application and closes the message channel; the
 * new page has its own content scripts, so pick up again there.
 *
 * `depth` guards the one hand-off this makes for itself, from a board's
 * receipt page to the application the same click opened elsewhere.
 */
async function applyInTab(tabId, job, depth = 0) {
  // Multi-page ATS flows (Workday, Taleo) load a new page per step.
  const MAX_PAGES = 10;
  const startedAt = Date.now();
  let lastError = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    await waitForTab(tabId);

    // The board sent this tab to its own record of the click. There is
    // nothing to apply with here; the application is in the tab the same
    // click opened.
    const here = await chrome.tabs.get(tabId).catch(() => null);
    if (here && isApplicationReceiptUrl(here.pendingUrl || here.url || "")) {
      if (depth > 0) {
        return { submitted: false, reason: "the job board recorded the apply click, but no application page opened" };
      }
      return followReceipt(tabId, job, startedAt);
    }

    // The shared scripts are declared for https://*/* so they are already
    // present; this only covers a tab that loaded too early.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/content/shared/takeover.js"],
    }).catch(() => {});

    try {
      return await chrome.tabs.sendMessage(tabId, { type: "TAKEOVER_APPLY_HERE", job });
    } catch (err) {
      lastError = String(err?.message || err);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) throw new Error("the application tab was closed");
      await info("Application moved to another page; following it", { url: tab.pendingUrl || tab.url });
      // Let the next page start loading before waiting for it to finish.
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return { submitted: false, reason: `the application kept moving between pages (${lastError})` };
}

/**
 * This tab is showing a board's receipt for an apply click. Carry the
 * application on in the tab that same click opened, and close the receipt.
 *
 * The board has recorded the click by now, but that is not an application:
 * it still has to be completed on the company's own site.
 */
async function followReceipt(tabId, job, since) {
  const application = await tabOpenedBy(tabId, since, 3000);
  if (!application || isApplicationReceiptUrl(application.pendingUrl || application.url || "")) {
    return {
      submitted: false,
      reason: "the job board recorded the apply click, but did not open an application to fill in",
    };
  }

  await info("The job board recorded the click; continuing in the company's own tab", {
    url: application.pendingUrl || application.url,
  });
  await chrome.tabs.update(application.id, { active: true }).catch(() => {});
  await closeReceiptTab(tabId);

  const result = await applyInTab(application.id, job, 1);

  // A challenge or a question for the user ends the run in the tab they need
  // to act in, so that one stays open and in front.
  if (!(result?.blocked || result?.stopped || result?.waitingForUser)) {
    await chrome.tabs.remove(application.id).catch(() => {});
  }
  return result;
}

// ---- Applications inside an embedded frame ---------------------------------
//
// A company careers page usually embeds its ATS — Greenhouse, Lever, Workday —
// rather than hosting the form itself. The page then offers no way to apply
// that its own scripts can see, because the form is in another document.
// A content script cannot reach into a frame, but the worker can address one.

/**
 * Run in every frame of a tab to ask what that frame is showing.
 *
 * This is serialised and injected, so it must not close over anything here.
 * It runs in the same isolated world as the content scripts, which is why it
 * can ask the adapter that is already there.
 */
function reportFrameState() {
  const snapshot = globalThis.genericObserver?.observe?.() || null;
  return {
    url: location.href,
    state: snapshot?.page?.applicationState || "unknown",
    fields: document.querySelectorAll("input, textarea, select").length,
  };
}

/** Ask every frame in `tabId` what it is showing, and pick the application. */
async function applicationFrame(tabId) {
  let injected;
  try {
    injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: reportFrameState,
    });
  } catch (err) {
    await info("Could not read this page's frames", { reason: String(err?.message || err) });
    return null;
  }

  // A frame that could not be injected — a blank one, or one whose document
  // went away mid-call — simply does not answer.
  const probes = (injected || [])
    .filter((entry) => entry && entry.result)
    .map((entry) => ({ frameId: entry.frameId, ...entry.result }));

  return pickApplicationFrame(probes);
}

/** Shape a results card, read as plain text, for the evaluator. */
function jobFromCard({ title = "", company = "", url = "", text = "" }) {
  const body = String(text).slice(0, 2000);
  return {
    id: url, url, title, company,
    summary: body,
    experience: experienceFromText(body),
    // The card does not mark which part is the location; the scorer only
    // looks for preferred cities (or "remote") in it, so the whole card works.
    location: body,
    postedOn: postedFromText(body),
    tags: [],
  };
}

/**
 * The experience a card asks for, in whatever way its board words it.
 *
 * Boards disagree: "2-5 Yrs", "3+ years", "Minimum 4 years experience",
 * "Entry level". Reading only the first form meant every other board scored
 * every job as "experience unknown", which silently disabled the experience
 * gate rather than failing loudly.
 */
function experienceFromText(text) {
  const patterns = [
    /\b\d+\s*-\s*\d+\s*(?:yrs?|years?)\b/i,     // 2-5 Yrs
    /\b\d+\s*\+\s*(?:yrs?|years?)\b/i,          // 3+ years
    /\b(?:min(?:imum)?|at least)\s*\d+\s*(?:yrs?|years?)\b/i,
    /\b\d+\s*(?:yrs?|years?)(?:\s+of)?\s+(?:exp|experience)\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  if (/\b(?:entry[- ]level|fresher|graduate|no experience required)\b/i.test(text)) return "0 years";
  return "";
}

/** When a card says the job was posted, in whatever way its board words it. */
function postedFromText(text) {
  const m = /\b(?:just now|today|yesterday|few hours ago|\d+\+?\s*(?:hour|day|week|month)s?\s+ago|posted\s+\d+\+?\s*(?:hour|day|week|month)s?\s+ago)\b/i.exec(text);
  return m ? m[0] : "";
}

function fitReason(ev) {
  const verdict = ev.decision === "APPLY" ? "Matches your profile"
    : ev.decision === "REVIEW" ? "Unclear match with your profile, left for you to review"
    : "Does not match your profile";
  const why = [...(ev.missing_requirements || []), ...(ev.risk_flags || []), ...(ev.reasons || [])]
    .slice(0, 3).join("; ");
  return `${verdict} (${ev.match_score}% match)${why ? `: ${why}` : ""}`;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "STATS":  return sendResponse(await stats());

      case "GET_STATUS":
        return sendResponse({ ok: true, stats: await stats(), log: await getLog(40) });

      case "RECORD_SUBMIT": {
        const traceRecSub = { stage: "RECORD_SUBMIT_handler", payload: msg.payload };
        console.log("[APPLY_TRACE]", JSON.stringify(traceRecSub));
        await persistApplyTrace(traceRecSub);
        await recordSubmit(msg.payload);
        const traceRecSubStats = { stage: "stats_after_submit", stats: await stats() };
        console.log("[APPLY_TRACE]", JSON.stringify(traceRecSubStats));
        await persistApplyTrace(traceRecSubStats);
        return sendResponse({ ok: true });
      }

      case "CLEAR_HALT":
        await clearHalt();
        return sendResponse({ ok: true });

      case "DELETE_DATA":
        await deleteAllUserData();
        return sendResponse({ ok: true });

      case "AI_DECIDE_ACTION": {
        // The content script sends a UISnapshot; we return a validated AgentAction.
        // API keys never leave the service worker — this is the only correct
        // place to call the LLM for UI decisions.
        const profile = await getProfile();
        try {
          // A screenshot is attached only when the DOM observation was not
          // enough (target not found, click had no effect, page ambiguous).
          // Every turn sending an image would be slow and costly — Part 23.
          const screenshot = msg.needVisual
            ? await captureForModel(sender?.tab?.windowId)
            : null;
          if (msg.needVisual) {
            await info("Visual context attached for AI decision", {
              captured: Boolean(screenshot),
              reason: msg.lastFailure?.verdict || "ambiguous page",
            });
          }
          const action = await decideAction(msg.snapshot, profile, askJSON, {
            screenshot,
            lastFailure: msg.lastFailure || null,
            job: msg.job || null,
          });
          return sendResponse({ ok: true, action, visual: Boolean(screenshot) });
        } catch (err) {
          // Retryable provider errors propagate the flag so the agent loop
          // can distinguish transient from permanent failures.
          return sendResponse({
            ok: false,
            error: String(err && err.message ? err.message : err),
            retryable: Boolean(err && err.retryable),
          });
        }
      }

      case "GET_APPLY_CONTEXT":
        return sendResponse({
          ok: true,
          profile: await getProfile(),
          resume: await getResume(),
        });

      // ---- Interaction diagnostics (Part 14/15) ---------------------------

      case "GET_DEBUG_MODE":
        return sendResponse({ ok: true, debug: await isDebugEnabled() });

      case "SET_DEBUG_MODE":
        return sendResponse({ ok: true, debug: await setDebugEnabled(msg.debug) });

      case "GET_DIAGNOSTICS":
        return sendResponse({
          ok: true,
          diagnostics: await getDiagnostics(msg.limit || 50),
          captures: await getCaptures(msg.captureLimit || 10),
          debug: await isDebugEnabled(),
        });

      case "CLEAR_DIAGNOSTICS":
        await clearDiagnostics();
        return sendResponse({ ok: true });

      case "CAPTURE_SCREENSHOT": {
        const dataUrl = await captureViewport(sender?.tab?.windowId);
        return sendResponse({ ok: Boolean(dataUrl), dataUrl });
      }

      case "CLICK_DIAGNOSTIC": {
        // Always persist the structured record; capture screenshots only for
        // failures while debug mode is on.
        await recordDiagnostic(msg.record);
        if (msg.captureScreenshots) {
          const after = await captureViewport(sender?.tab?.windowId);
          await storeFailureCapture({
            record: msg.record,
            before: msg.screenshotBefore || null,
            after,
            domSnapshot: msg.domSnapshot || null,
            url: sender?.tab?.url,
            title: sender?.tab?.title,
          });
        }
        if (msg.record?.result && msg.record.result !== "ACTION_CONFIRMED") {
          await warn("Interaction did not take effect", {
            action: msg.record.action,
            target: msg.record.target,
            targetText: msg.record.targetText,
            method: msg.record.method,
            result: msg.record.result,
            retries: msg.record.retryCount,
          });
        }
        return sendResponse({ ok: true });
      }

      // ---- Takeover: following a job into a new tab -----------------------
      //
      // A job board often opens the company's own application in a NEW tab. A
      // content script cannot see or drive another tab, so the takeover
      // session asks the worker to run the application there and report back.
      // The user watches it happen: the tab is focused, never hidden, and it
      // is closed only if the worker opened it.

      case "TAB_OPENED_SINCE": {
        // Asked by the executor after a click: did that click open a tab?
        const sourceTabId = sender?.tab?.id;
        if (!sourceTabId) return sendResponse({ ok: true, opened: false });
        const tab = await tabOpenedBy(sourceTabId, Number(msg.since) || 0, msg.waitMs);
        return sendResponse(tab
          ? { ok: true, opened: true, tab: { id: tab.id, url: tab.pendingUrl || tab.url || "" } }
          : { ok: true, opened: false });
      }

      case "OPEN_TAB_FROM_PAGE": {
        // A results page opening a job in a new tab. The worker does it,
        // because Chrome blocks a page's scripted new-tab clicks as pop-ups.
        const url = safeHttpUrl(msg.url);
        const source = sender?.tab;
        if (!url) return sendResponse({ ok: false, error: "refused: only http(s) URLs may be opened" });
        if (!source?.id) return sendResponse({ ok: false, error: "no originating tab" });
        const tab = await chrome.tabs.create({
          url, active: true, openerTabId: source.id, index: source.index + 1,
        });
        openedTabs.set(tab.id, { id: tab.id, openerTabId: source.id, createdAt: Date.now() });
        return sendResponse({ ok: true, tab: { id: tab.id, url } });
      }

      case "TAKEOVER_EVALUATE_JOB": {
        // Before the agent opens a job: may it apply at all, and does this job
        // fit the candidate?
        const profile = await getProfile();
        if (!profile?._validation?.ok) {
          return sendResponse({
            ok: false,
            error: "Complete and save a valid candidate profile first: the agent only applies to jobs that match it.",
          });
        }

        // The governor is what stands between "useful" and "account
        // restricted", and this is the only gate every application passes
        // through. Pressing "Take over" is the user's own go-ahead, so the
        // master switch is not consulted here — the caps and the breaker are.
        const gate = await canSubmit({ requireEnabled: false });
        if (!gate.ok && gate.reason !== "pacing") {
          await info("Run held by the governor", { reason: gate.reason });
          return sendResponse({ ok: true, decision: "STOP", reason: gate.reason });
        }

        const settings = await getSettings();
        const job = jobFromCard(msg.job || {});
        // The model is consulted only for jobs the heuristic finds uncertain.
        const ev = await evaluateJobWithModel(job, profile, askJSON, {
          minRelevance: settings.governor.minRelevance,
          preferences: settings.preferences,
        });
        await info("Takeover job evaluated", { title: job.title, decision: ev.decision, match_score: ev.match_score });
        return sendResponse({ ok: true, decision: ev.decision, match_score: ev.match_score, reason: fitReason(ev) });
      }

      case "APPLY_IN_FRAME": {
        // The page found no way to apply. Its application may be embedded in
        // a frame, which only the worker can address.
        const tabId = sender?.tab?.id;
        if (!tabId) return sendResponse({ ok: false, error: "no originating tab" });

        const frame = await applicationFrame(tabId);
        if (!frame) return sendResponse({ ok: true, found: false });

        await info("The application is in an embedded frame; continuing there", { url: frame.url });
        try {
          const result = await chrome.tabs.sendMessage(
            tabId,
            { type: "TAKEOVER_APPLY_HERE", job: msg.job || null, toFrame: true },
            { frameId: frame.frameId },
          );
          return sendResponse({ ok: true, found: true, result });
        } catch (err) {
          // The frame navigated or was removed while it was being driven.
          return sendResponse({ ok: true, found: true, result: {
            submitted: false,
            reason: `the embedded application stopped responding (${String(err?.message || err)})`,
          } });
        }
      }

      case "CLOSE_OPENED_TAB": {
        // The agent opened a page it did not want (a company profile, a
        // reviews site). Close it and bring back the page it was working on.
        const sourceTabId = sender?.tab?.id;
        const tab = sourceTabId && await childTab(sourceTabId, msg.tabId);
        if (!tab) return sendResponse({ ok: false, error: "refused: this page did not open that tab" });
        await chrome.tabs.remove(tab.id).catch(() => {});
        await chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
        return sendResponse({ ok: true });
      }

      case "TAKEOVER_ADOPT_NEW_TAB": {
        const sourceTabId = sender?.tab?.id;
        if (!sourceTabId) return sendResponse({ ok: false, error: "no originating tab" });

        // The exact tab the click opened, or else one this page opened since
        // the click. Never an older tab: the user may have opened jobs of
        // their own from the same results page.
        // One click can open two tabs, and the second can arrive a moment
        // after the first, so wait rather than take whatever exists now:
        // picking the board's receipt page over the application costs the
        // whole job.
        const adopted = msg.tabId != null
          ? await childTab(sourceTabId, msg.tabId)
          : msg.since != null
            ? await tabOpenedBy(sourceTabId, Number(msg.since), 1500)
            : null;

        if (!adopted) return sendResponse({ ok: true, adopted: false });

        try {
          await chrome.tabs.update(adopted.id, { active: true });
          const result = await applyInTab(adopted.id, msg.job || null);

          // A challenge or a question for the user ends the run: leave that
          // tab open and in front, where they can act on it.
          if (result?.blocked || result?.stopped || result?.waitingForUser) {
            return sendResponse({ ok: true, adopted: true, result });
          }

          // Return to the results so the run can continue.
          await chrome.tabs.remove(adopted.id).catch(() => {});
          await chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});

          return sendResponse({ ok: true, adopted: true, result });
        } catch (err) {
          await chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
          return sendResponse({ ok: false, adopted: true, error: String(err?.message || err) });
        }
      }

      // ---- Tab-level actions requested by the agent -----------------------
      //
      // The content script cannot open, switch or close tabs. It asks here,
      // and this handler validates the request — in particular, a navigation
      // URL must be http(s), so a `javascript:` URL can never be navigated to,
      // and a page may only act on a tab it opened itself.

      case "AGENT_TAB_ACTION": {
        const tabId = sender?.tab?.id;
        try {
          switch (msg.tabAction) {
            case "navigate": {
              const url = safeHttpUrl(msg.url);
              if (!url) return sendResponse({ ok: false, error: "refused: only http(s) URLs may be navigated to" });
              if (!tabId) return sendResponse({ ok: false, error: "no originating tab" });
              await chrome.tabs.update(tabId, { url });
              return sendResponse({ ok: true, url });
            }
            case "open_tab": {
              const url = safeHttpUrl(msg.url);
              if (!url) return sendResponse({ ok: false, error: "refused: only http(s) URLs may be opened" });
              if (!tabId) return sendResponse({ ok: false, error: "no originating tab" });
              const created = await chrome.tabs.create({ url, active: true, openerTabId: tabId });
              openedTabs.set(created.id, { id: created.id, openerTabId: tabId, createdAt: Date.now() });
              return sendResponse({ ok: true, tabId: created.id });
            }
            case "switch_tab": {
              const target = tabId && await childTab(tabId, msg.tabId);
              if (!target) return sendResponse({ ok: false, error: "refused: this page did not open that tab" });
              await chrome.tabs.update(target.id, { active: true });
              return sendResponse({ ok: true, tabId: target.id });
            }
            case "close_tab": {
              // The run lives in this page's own scripts, so closing this tab
              // would end it. Only a tab this page opened may be closed.
              const target = tabId && await childTab(tabId, msg.tabId);
              if (!target) {
                return sendResponse({ ok: false, error: "refused: only a tab this page opened may be closed" });
              }
              await chrome.tabs.remove(target.id);
              await chrome.tabs.update(tabId, { active: true }).catch(() => {});
              return sendResponse({ ok: true });
            }
            default:
              return sendResponse({ ok: false, error: `unknown tab action: ${msg.tabAction}` });
          }
        } catch (err) {
          return sendResponse({ ok: false, error: String(err?.message || err) });
        }
      }

      case "RESOLVE_ANSWER": {
        const profile = await getProfile();
        const hit = await resolveAnswer(msg.question, msg.options, profile);
        return sendResponse({
          ok: true,
          action: hit.action,
          answer: hit.answer,
          source: hit.source,
          confidence: hit.confidence,
          profileHint: profileHintForQuestion(msg.question),
        });
      }

      case "UPLOAD_RESUME":  return sendResponse({ ok: true, ...(await storeResume(msg.file)) });
      case "PARSE_RESUME":   return sendResponse({ ok: true, profile: await parseResume() });
      case "ANOMALY": await halt(msg.reason);     return sendResponse({ ok: true });
      default: return sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true;   // keep the channel open for the async reply
});
