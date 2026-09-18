// Orchestrator.
//
// The agent runs in the tab the user is watching: they open a page, write
// what they want done, and press "Take over". The run itself lives here, in
// src/lib/takeover-driver.js by way of ./takeover-session.js, because a run
// that lived in the page ended whenever the page navigated — and on a job
// board, Apply navigating the tab is normal. The page's scripts are the
// agent's eyes and hands; this worker is the part that decides, reads the
// profile and resume, holds the API keys, and sees across tabs.
//
// What a page is — a list of jobs, one job, an application, a confirmation —
// is never decided by a rule here. The model reads the page and says.
//
// The worker is evicted after ~30s idle, so nothing that must survive lives in
// module scope. The exceptions are the run in progress, which keeps the
// worker awake while it lasts, and the record of which tab opened which, which
// is only meaningful during a run.

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
  startTakeover, stopTakeover, pauseTakeover, resumeTakeover, takeoverStatus,
} from "./takeover-session.js";
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

/**
 * Fill the application held in one of `tabId`'s frames, if one holds it.
 * Returns null when no frame does, which is the usual case.
 */
async function applyInFrame(tabId, job, instruction) {
  const frame = await applicationFrame(tabId);
  if (!frame) return null;

  await info("The application is in an embedded frame; continuing there", { url: frame.url });
  try {
    const result = await chrome.tabs.sendMessage(
      tabId,
      { type: "FILL_APPLICATION", job: job || null, instruction, force: true, toFrame: true },
      { frameId: frame.frameId },
    );
    return result || { submitted: false, reason: "the embedded application did not report a result" };
  } catch (err) {
    // The frame navigated or was removed while it was being driven.
    return { submitted: false, reason: `the embedded application stopped responding (${String(err?.message || err)})` };
  }
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

/**
 * Before the agent opens a job: may it apply at all, and does this job fit
 * the candidate? Returns { decision, reason } or { error }.
 */
async function evaluateTakeoverJob(card) {
  const profile = await getProfile();
  if (!profile?._validation?.ok) {
    return { error: "Complete and save a valid candidate profile first: the agent only applies to jobs that match it." };
  }

  // The governor is what stands between "useful" and "account restricted",
  // and every application passes through here. Pressing "Take over" is the
  // user's own go-ahead, so the master switch is not consulted — the caps and
  // the breaker are.
  const gate = await canSubmit({ requireEnabled: false });
  if (!gate.ok && gate.reason !== "pacing") {
    await info("Run held by the governor", { reason: gate.reason });
    return { decision: "STOP", reason: gate.reason };
  }

  const settings = await getSettings();
  const job = jobFromCard(card || {});
  // The model is consulted only for jobs the heuristic finds uncertain.
  const ev = await evaluateJobWithModel(job, profile, askJSON, {
    minRelevance: settings.governor.minRelevance,
    preferences: settings.preferences,
  });
  await info("Takeover job evaluated", { title: job.title, decision: ev.decision, match_score: ev.match_score });
  return { decision: ev.decision, match_score: ev.match_score, reason: fitReason(ev) };
}

/** Count a verified application against the governor's caps, and trace it. */
async function recordApplied(entry) {
  let site = "";
  try { site = new URL(entry.url).hostname; } catch (_) { /* no address */ }
  const payload = { ...entry, site };
  const trace = { stage: "RECORD_SUBMIT_handler", payload };
  console.log("[APPLY_TRACE]", JSON.stringify(trace));
  await persistApplyTrace(trace);
  await recordSubmit(payload);
  const after = { stage: "stats_after_submit", stats: await stats() };
  console.log("[APPLY_TRACE]", JSON.stringify(after));
  await persistApplyTrace(after);
}

/** What a takeover run needs from the worker. */
const takeoverServices = {
  askJSON,
  captureForModel,
  evaluateJob: evaluateTakeoverJob,
  recordApplied,
  tabOpenedBy,
  rememberOpenedTab: (tabId, openerTabId) =>
    openedTabs.set(tabId, { id: tabId, openerTabId, createdAt: Date.now() }),
  applyInFrame,
  waitForTab,
  safeHttpUrl,
  info,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "STATS":  return sendResponse(await stats());

      case "GET_STATUS":
        return sendResponse({ ok: true, stats: await stats(), log: await getLog(40) });

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
            instruction: msg.instruction || "",
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

      // ---- Tabs a click opened ---------------------------------------------
      //
      // A content script cannot see another tab, so it asks here whether its
      // click opened one, and asks for a detour it did not want to be closed.

      case "TAB_OPENED_SINCE": {
        // Asked by the executor after a click: did that click open a tab?
        const sourceTabId = sender?.tab?.id;
        if (!sourceTabId) return sendResponse({ ok: true, opened: false });
        const tab = await tabOpenedBy(sourceTabId, Number(msg.since) || 0, msg.waitMs);
        return sendResponse(tab
          ? { ok: true, opened: true, tab: { id: tab.id, url: tab.pendingUrl || tab.url || "" } }
          : { ok: true, opened: false });
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

      // ---- The takeover run, controlled from the side panel ---------------

      case "TAKEOVER_START": {
        const tabId = Number(msg.tabId);
        if (!tabId) return sendResponse({ ok: false, error: "no tab to take over" });
        const options = msg.options || {};
        await info("Takeover started", { tabId, instruction: options.instruction || "" });
        const summary = await startTakeover({
          tabId,
          instruction: options.instruction,
          maxJobs: options.maxJobs,
          maxPages: options.maxPages,
        }, takeoverServices);
        await info("Takeover ended", {
          applied: summary.appliedCount, skipped: summary.skippedCount, reason: summary.reason || summary.error,
        });
        return sendResponse(summary);
      }

      case "TAKEOVER_STOP":   return sendResponse({ ok: stopTakeover() });
      case "TAKEOVER_PAUSE":  return sendResponse({ ok: pauseTakeover() });
      case "TAKEOVER_RESUME": return sendResponse({ ok: resumeTakeover() });
      case "TAKEOVER_STATUS": return sendResponse({ ok: true, ...takeoverStatus() });

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
