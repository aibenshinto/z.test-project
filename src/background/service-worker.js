// Orchestrator. The service worker is evicted after ~30s idle, so the run loop
// is driven by chrome.alarms + storage, never by setTimeout or module state.

import { getSettings, get, set, deleteAllUserData } from "../lib/storage.js";
import { canSubmit, recordSubmit, halt, clearHalt, stats, randomDelay } from "./governor.js";
import { resolve as resolveAnswer, remember } from "../lib/answer-bank.js";
import { getResume, getProfile, parseResume, storeResume } from "../lib/resume.js";
import { evaluateJob, evaluateJobWithModel } from "../lib/evaluator.js";
import { modelRerank } from "../lib/ranker.js";
import { askJSON } from "../lib/llm/index.js";
import { emptySession, transition, STATES } from "../lib/agent-fsm.js";
import { info, warn, getLog } from "../lib/logger.js";
import { platformFromJob, platformFromUrl, isApplicationReceiptUrl } from "../lib/platforms.js";
import { profileHintForQuestion } from "../lib/questions.js";
import { decideAction, buildCandidateContext } from "../lib/ui-agent.js";
import {
  isDebugEnabled, setDebugEnabled, recordDiagnostic, getDiagnostics,
  clearDiagnostics, captureViewport, captureForModel, storeFailureCapture, getCaptures,
} from "../lib/debug-store.js";

const TICK = "autoapply-tick";
const SESSION = "agentSession";

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

function adapterResult(value, fallbackReason = "The platform did not return a completion confirmation.") {
  if (!value) return { submitted: false, reason: fallbackReason };
  if (value.ok === false) return { submitted: false, reason: value.error || fallbackReason };
  return value;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TICK) await tick();
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
 * One click can open two tabs: Naukri's "Apply on company site" opens the
 * company's page and its own receipt page. The receipt is never the
 * application, so it is passed over while any other candidate exists — and
 * taken only when it is the only thing that opened, so the caller can say
 * what happened.
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

/** Shape a results card, read as plain text, for the evaluator. */
function jobFromCard({ title = "", company = "", url = "", text = "" }) {
  const body = String(text).slice(0, 2000);
  return {
    id: url, url, title, company,
    summary: body,
    experience: (body.match(/\d+\s*-\s*\d+\s*yrs?/i) || [""])[0],
    // The card does not mark which part is the location; the scorer only
    // looks for preferred cities (or "remote") in it, so the whole card works.
    location: body,
    postedOn: (body.match(/\b(?:just now|today|few hours ago|\d+\+?\s*(?:day|week|month)s?\s+ago)\b/i) || [""])[0],
    tags: [],
  };
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

async function loadSession() {
  return (await get(SESSION, null)) || emptySession();
}

async function saveSession(s) {
  await set(SESSION, s);
  return s;
}

export async function startRun() {
  await clearHalt();
  let s = await loadSession();
  s = { ...emptySession(), paused: false, state: STATES.IDLE };
  s = transition(s, STATES.DISCOVERING_JOB, { progress: { step: 0, total: 0, action: "starting" } });
  await saveSession(s);
  await chrome.alarms.create(TICK, { periodInMinutes: 1 });
  await info("Run started");
  await tick();
}

export async function stopRun(reason = "stopped by user") {
  await chrome.alarms.clear(TICK);
  const s = await loadSession();
  await saveSession({ ...s, state: STATES.STOPPED, paused: false, pendingQuestion: null, lastError: reason, updatedAt: Date.now() });
  await halt(reason);
  await info("Run stopped", { reason });
}

export async function pauseRun() {
  const s = await loadSession();
  try {
    await saveSession(transition(s, STATES.PAUSED, { paused: true, progress: { ...s.progress, action: "paused" } }));
  } catch {
    await saveSession({ ...s, state: STATES.PAUSED, paused: true, updatedAt: Date.now() });
  }
  await chrome.alarms.clear(TICK);
  await info("Run paused");
}

export async function resumeRun() {
  await clearHalt();
  let s = await loadSession();
  s = { ...s, paused: false };
  if (s.state === STATES.PAUSED || s.state === STATES.STOPPED) {
    const next = s.pendingQuestion ? STATES.WAITING_FOR_USER : STATES.DISCOVERING_JOB;
    try { s = transition({ ...s, state: STATES.PAUSED }, next, { paused: false }); }
    catch { s = { ...s, state: next, paused: false, updatedAt: Date.now() }; }
  }
  await saveSession(s);
  await chrome.alarms.create(TICK, { periodInMinutes: 1 });
  await info("Run resumed");
  await tick();
}

function force(session, state, patch = {}) {
  try {
    return transition(session, state, patch);
  } catch {
    return { ...session, ...patch, state, updatedAt: Date.now() };
  }
}

/** A job is already known when its stable platform id, canonical URL, or a
 * submitted company/title pair is present. Keep this in the worker so every
 * platform uses the same duplicate policy. */
function duplicateOf(queue, job) {
  return queue.some((j) =>
    (j.id && job.id && j.id === job.id) ||
    (j.url && job.url && j.url === job.url) ||
    (j.company && j.title && j.company === job.company && j.title === job.title &&
      ["submitted", "applied", "APPLYING"].includes(j.status))
  );
}

let tickRunning = false;

// One unit of work per tick: take the highest-ranked queued job and try it.
async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const session = await loadSession();
    if (session.paused || session.state === STATES.STOPPED) return;
    if (session.state === STATES.WAITING_FOR_USER || session.state === STATES.BLOCKED) {
      await info("Holding for user", { state: session.state });
      return;
    }

  const gate = await canSubmit();
  if (!gate.ok) {
    console.debug("[tick] holding:", gate.reason);
    if (gate.waitMs) {
      await chrome.alarms.create(TICK, { when: Date.now() + gate.waitMs + 1000 });
    }
    return;
  }

  const queue = await get("queue", []);
  const settings = await getSettings();
  const profile = await getProfile();
  const next = queue
    .filter((j) => j.status === "ready")
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))[0];

  if (!next) {
    await saveSession({ ...emptySession(), updatedAt: Date.now() });
    return;
  }

  let s = emptySession();
  s = transition(s, STATES.DISCOVERING_JOB, { jobId: next.id });
  s = transition(s, STATES.EVALUATING_JOB, { jobId: next.id });

  // Discovery stays local and cheap. Just before a real application, obtain
  // one structured, conservative model judgement for the selected job. A
  // model failure falls back to the deterministic evaluation in this module.
  const ev = await evaluateJobWithModel(next, profile || {}, askJSON, {
    minRelevance: settings.governor.minRelevance,
    preferences: settings.preferences,
  });

  // Check if the user paused or stopped the run while the model was evaluating.
  const postEvalSession = await loadSession();
  if (postEvalSession.paused || postEvalSession.state === STATES.STOPPED) return;

  next.evaluation = ev;
  next.relevance = ev.relevance;
  next.match_score = ev.match_score;
  await info("Job evaluated", { title: next.title, decision: ev.decision, match_score: ev.match_score });

  if (ev.decision === "SKIP") {
    next.status = "skipped";
    next.result = { reason: ev.reasons.join("; ") };
    await set("queue", queue);
    try { s = transition(s, STATES.SKIPPED, { progress: { action: "skipped", step: 0, total: 0 } }); }
    catch { s = { ...s, state: STATES.SKIPPED }; }
    await saveSession(s);
    await chrome.alarms.create(TICK, { when: Date.now() + 1500 });
    return;
  }

  if (ev.decision === "REVIEW") {
    next.status = "review";
    next.result = { reason: "Needs review: " + ev.reasons.slice(0, 2).join("; ") };
    await set("queue", queue);
    try { s = transition(s, STATES.SKIPPED, { progress: { action: "queued for review" } }); }
    catch { s = { ...s, state: STATES.SKIPPED }; }
    await saveSession(s);
    await chrome.alarms.create(TICK, { when: Date.now() + 1500 });
    return;
  }

  if ((next.relevance || 0) < settings.governor.minRelevance) {
    next.status = "skipped";
    await set("queue", queue);
    return;
  }

  try {
    try { s = transition(s, STATES.OPENING_APPLICATION, { progress: { action: "opening", step: 1, total: 5 } }); }
    catch { s.state = STATES.OPENING_APPLICATION; }
    await saveSession(s);

    const result = await applyToJob(next, s);
    const traceEntryReceived = { stage: "worker_received", jobId: next.id, title: next.title, company: next.company, url: next.url, result, submitted: result?.submitted };
    console.log("[APPLY_TRACE]", JSON.stringify(traceEntryReceived));
    await persistApplyTrace(traceEntryReceived);
    
    next.status = result.submitted ? "submitted"
      : result.waitingForUser ? "waiting_for_user"
      : result.blocked ? "blocked"
      : result.halt ? "blocked"
      : "needs_review";
    next.result = result;

    if (result.submitted) {
      const traceEntryRecordSubmit = { stage: "tick_recordSubmit_called", site: next.site, jobId: next.id, title: next.title, company: next.company, url: next.url };
      console.log("[APPLY_TRACE]", JSON.stringify(traceEntryRecordSubmit));
      await persistApplyTrace(traceEntryRecordSubmit);
      await recordSubmit(next);
      const traceStats = { stage: "stats_after_submit", stats: await stats() };
      console.log("[APPLY_TRACE]", JSON.stringify(traceStats));
      await persistApplyTrace(traceStats);
    } else {
      const traceEntryNotCalled = { stage: "tick_result_false", site: next.site, jobId: next.id, title: next.title, company: next.company, url: next.url, reason: result?.reason };
      console.log("[APPLY_TRACE]", JSON.stringify(traceEntryNotCalled));
      await persistApplyTrace(traceEntryNotCalled);
    }
    if (!result.submitted) {
      await warn("Application requires attention", {
        jobId: next.id,
        title: next.title,
        status: next.status,
        // APPLICATION_STATUS_UNKNOWN means the agent acted but could not prove
        // the application was submitted — distinct from a confirmed failure.
        applicationStatus: result.applicationStatus || "APPLICATION_STATUS_UNKNOWN",
        reason: result.reason || "The platform did not return a completion confirmation.",
      });
    }

    if (result.halt) {
      await set("queue", queue);
      await saveSession({ ...await loadSession(), state: STATES.BLOCKED, lastError: result.reason });
      return halt(result.reason);
    }

    if (result.waitingForUser) {
      await set("queue", queue);
      return;
    }

    if (result.blocked) {
      await set("queue", queue);
      return;
    }
  } catch (err) {
    next.status = "error";
    next.error = String(err);
    await warn("Application failed", {
      jobId: next.id,
      title: next.title,
      reason: String(err && err.message ? err.message : err),
    });
    if (err && err.retryable) {
      console.warn("[tick] provider unavailable, will retry next tick:", err.message);
      next.status = "ready";
      await set("queue", queue);
      return chrome.alarms.create(TICK, { when: Date.now() + 120000 });
    }

    if (/captcha|verify|blocked|unexpected dom|cloudflare/i.test(String(err))) {
      next.status = "blocked";
      await set("queue", queue);
      await saveSession({
        ...(await loadSession()),
        state: STATES.BLOCKED,
        lastError: String(err),
        pendingQuestion: {
          kind: "blocked",
          question: "Application blocked",
          reason: String(err),
        },
        updatedAt: Date.now(),
      });
      await halt(`anomaly on ${next.id}: ${err}`);
      return;
    }
  }

  await set("queue", queue);
  await chrome.alarms.create(TICK, {
    when: Date.now() + randomDelay(settings.governor),
  });
  } finally {
    tickRunning = false;
  }
}

async function applyToJob(job, session) {
  const existing = session.tabId;
  let tabId = existing;
  if (tabId) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) tabId = null;
  }
  if (!tabId) {
    const tab = await chrome.tabs.create({ url: job.url, active: true });
    tabId = tab.id;
  }
  await saveSession({
    ...(await loadSession()),
    tabId,
    jobId: job.id,
    state: STATES.OPENING_APPLICATION,
    updatedAt: Date.now(),
  });

  try {
    await waitForTab(tabId);
    const platform = platformFromJob(job);
    await saveSession({
      ...(await loadSession()),
      state: STATES.ANSWERING_FORM,
      progress: { step: 2, total: 5, action: "answering questions" },
      updatedAt: Date.now(),
    });
    const traceSend = { stage: "applyToJob_sending", site: job.site, jobId: job.id, title: job.title, company: job.company, url: job.url };
    console.log("[APPLY_TRACE]", JSON.stringify(traceSend));
    await persistApplyTrace(traceSend);
    let result = adapterResult(await chrome.tabs.sendMessage(tabId, { type: platform.applyMessage, job }));
    const traceReceived = { stage: "applyToJob_received", result };
    console.log("[APPLY_TRACE]", JSON.stringify(traceReceived));
    await persistApplyTrace(traceReceived);

    if (result && result.waitingForUser) {
      await saveSession({
        ...(await loadSession()),
        state: STATES.WAITING_FOR_USER,
        tabId,
        pendingQuestion: {
          kind: "field",
          question: result.question,
          suggested: result.suggested || "",
          confirm: result.confirm,
          profileHint: result.profileHint || profileHintForQuestion(result.question),
        },
        progress: { step: 3, total: 5, action: "waiting for you" },
        updatedAt: Date.now(),
      });
      await info("User input required", { question: result.question });
      // Bring the stuck tab to the front so the user can see where the agent paused.
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      return result;
    }

    if (result && (result.blocked || /captcha/i.test(result.reason || ""))) {
      await saveSession({
        ...(await loadSession()),
        state: STATES.BLOCKED,
        tabId,
        lastError: result.reason,
        pendingQuestion: { kind: "blocked", reason: result.reason, question: result.reason },
        updatedAt: Date.now(),
      });
      return { ...result, blocked: true };
    }

    if (result && result.external) {
      if (!result.externalUrl) {
        const discoveredUrl = await discoverExternalCompanyUrl(tabId);
        if (!discoveredUrl) {
          result = {
            ...result,
            reason: "Naukri’s “Apply on company site” button was clicked, but no external HTTPS page opened within 12 seconds.",
          };
          await chrome.tabs.remove(tabId).catch(() => {});
          await saveSession({
            ...(await loadSession()),
            state: STATES.FAILED,
            tabId: null,
            lastError: result.reason,
            updatedAt: Date.now(),
          });
          return result;
        }
        result = { ...result, externalUrl: discoveredUrl };
      }
      return handoffToExternalApplication(job, tabId, result);
    }

    if (result && result.submitted) {
      await saveSession({
        ...(await loadSession()),
        state: STATES.COMPLETED,
        tabId: null,
        pendingQuestion: null,
        progress: { step: 5, total: 5, action: "submitted" },
        updatedAt: Date.now(),
      });
      await chrome.tabs.remove(tabId).catch(() => {});
      await info("Application submitted", { jobId: job.id });
      return result;
    }

    await chrome.tabs.remove(tabId).catch(() => {});
    await saveSession({
      ...(await loadSession()),
      tabId: null,
      state: STATES.FAILED,
      lastError: result && result.reason,
      updatedAt: Date.now(),
    });
    return result || { submitted: false, reason: "no result from adapter" };
  } catch (err) {
    await chrome.tabs.remove(tabId).catch(() => {});
    throw err;
  }
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

async function userAnswerAndContinue(answer) {
  const session = await loadSession();
  const queue = await get("queue", []);
  const job = queue.find((j) => j.id === session.jobId) || queue.find((j) => j.status === "waiting_for_user");
  if (!job) return { ok: false, error: "no job waiting" };
  if (session.pendingQuestion?.question) {
    await remember(session.pendingQuestion.question, answer, { source: "user", confidence: 1 });
  }
  let s = session;
  try { s = transition(session, STATES.ANSWERING_FORM, { pendingQuestion: null, paused: false }); }
  catch { s = { ...session, state: STATES.ANSWERING_FORM, pendingQuestion: null }; }
  await saveSession(s);

  const tabId = session.tabId;
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!tab) {
    job.status = "error";
    job.error = "tab_closed";
    await set("queue", queue);
    await saveSession({ ...s, state: STATES.FAILED, lastError: "tab closed", tabId: null });
    return { ok: false, error: "tab closed — job marked failed" };
  }

  const platform = platformFromJob(job);
  // For the generic adapter: send GENERIC_CONTINUE so the agent-loop
  // re-observes the current DOM state after the user filled a field manually.
  const result = adapterResult(await chrome.tabs.sendMessage(tabId, {
    type: session.adapter === "generic" ? "GENERIC_CONTINUE" : platform.continueMessage,
    job,
    answer,
  }));
  job.result = result;
  if (result && result.waitingForUser) {
    job.status = "waiting_for_user";
    await set("queue", queue);
    await saveSession({
      ...s,
      state: STATES.WAITING_FOR_USER,
      adapter: session.adapter,
      pendingQuestion: {
        kind: "field",
        question: result.question,
        suggested: result.suggested || "",
        confirm: result.confirm,
        profileHint: result.profileHint || profileHintForQuestion(result.question),
      },
      updatedAt: Date.now(),
    });
    return { ok: true, waiting: true };
  }
  if (result && result.submitted) {
    const traceUac = { stage: "userAnswerAndContinue_recordSubmit_called", site: job.site, jobId: job.id, title: job.title, company: job.company, url: job.url };
    console.log("[APPLY_TRACE]", JSON.stringify(traceUac));
    await persistApplyTrace(traceUac);
    job.status = "submitted";
    await recordSubmit(job);
    await chrome.tabs.remove(tabId).catch(() => {});
    await set("queue", queue);
    await saveSession({ ...emptySession(), state: STATES.COMPLETED, updatedAt: Date.now() });
    await chrome.alarms.create(TICK, { when: Date.now() + 2000 });
    return { ok: true, submitted: true };
  }
  if (result && result.blocked) {
    job.status = "blocked";
    await set("queue", queue);
    await saveSession({
      ...s,
      state: STATES.BLOCKED,
      lastError: result.reason,
      pendingQuestion: { kind: "blocked", question: result.reason, reason: result.reason },
      updatedAt: Date.now(),
    });
    await halt(`security block on ${job.id}: ${result.reason}`);
    return { ok: true, blocked: true };
  }
  job.status = result && result.halt ? "blocked" : "needs_review";
  await chrome.tabs.remove(tabId).catch(() => {});
  await set("queue", queue);
  await saveSession({ ...emptySession(), state: STATES.FAILED, lastError: result && result.reason, updatedAt: Date.now() });
  await chrome.alarms.create(TICK, { when: Date.now() + 2000 });
  return { ok: true, result };
}

async function discoverExternalCompanyUrl(sourceTabId, timeoutMs = 12000) {
  const clicked = adapterResult(await chrome.tabs.sendMessage(sourceTabId, {
    type: "OPEN_EXTERNAL_COMPANY_SITE",
  }), "The company-site button could not be clicked.");
  if (!clicked.clicked) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const source = await chrome.tabs.get(sourceTabId).catch(() => null);
    if (source && permissionPatternFor(source.url)) return source.url;

    const children = await chrome.tabs.query({ openerTabId: sourceTabId }).catch(() => []);
    const destination = children.find((tab) => permissionPatternFor(tab.url));
    if (destination?.url) {
      await chrome.tabs.remove(destination.id).catch(() => {});
      return destination.url;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function permissionPatternFor(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || /(^|\.)naukri\.com$/i.test(parsed.hostname)) return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

async function handoffToExternalApplication(job, sourceTabId, result) {
  const externalUrl = result.externalUrl;
  const origin = permissionPatternFor(externalUrl);
  if (!origin) {
    await chrome.tabs.remove(sourceTabId).catch(() => {});
    await saveSession({
      ...(await loadSession()),
      state: STATES.FAILED,
      tabId: null,
      lastError: result.reason || "External application has no safe HTTPS destination URL.",
      updatedAt: Date.now(),
    });
    return { ...result, reason: result.reason || "External application has no safe HTTPS destination URL." };
  }

  job.externalApplication = { url: externalUrl, origin };
  const granted = await chrome.permissions.contains({ origins: [origin] });
  await chrome.tabs.remove(sourceTabId).catch(() => {});
  if (!granted) {
    await saveSession({
      ...(await loadSession()),
      state: STATES.WAITING_FOR_USER,
      tabId: null,
      pendingQuestion: {
        kind: "external_permission",
        question: `Allow AutoApply to assist on ${new URL(externalUrl).hostname}?`,
        reason: "This company application is hosted outside Naukri. Permission is needed only for this website.",
        externalUrl,
        externalOrigin: origin,
      },
      progress: { step: 2, total: 5, action: "waiting for company-site permission" },
      updatedAt: Date.now(),
    });
    await info("Company-site permission required", { jobId: job.id, origin });
    return { waitingForUser: true, external: true, reason: "Permission is required to assist on the company website." };
  }
  return beginExternalApplication(job, externalUrl);
}

async function beginExternalApplication(job, externalUrl) {
  // Open visibly so the user can watch the agent navigate the company site.
  const tab = await chrome.tabs.create({ url: externalUrl, active: true });
  const tabId = tab.id;
  await saveSession({
    ...(await loadSession()),
    state: STATES.OPENING_APPLICATION,
    tabId,
    jobId: job.id,
    pendingQuestion: null,
    adapter: "generic",
    progress: { step: 2, total: 5, action: "opening company application" },
    updatedAt: Date.now(),
  });
  try {
    await waitForTab(tabId);
    // Inject in dependency order: highlight ring → observer → executor → agent-loop → shim
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        "src/content/shared/highlight.js",
        "src/content/shared/interaction-core-bridge.js",
        "src/content/shared/observer-core.js",
        "src/content/shared/pointer-actions.js",
        "src/content/shared/diagnostics.js",
        "src/content/shared/executor-core.js",
        "src/content/shared/agent-loop-core.js",
        "src/content/generic/observer.js",
        "src/content/generic/executor.js",
        "src/content/generic/agent-loop.js",
        "src/content/generic/apply.js",
      ],
    });
    // Brief settle time for the agent-loop message listener to register.
    await new Promise((r) => setTimeout(r, 300));
    const result = adapterResult(await chrome.tabs.sendMessage(tabId, { type: "GENERIC_APPLY", job }),
      "The company-site adapter did not return a result.");
    job.result = result;
    if (result?.waitingForUser) {
      await saveSession({
        ...(await loadSession()),
        state: STATES.WAITING_FOR_USER,
        tabId,
        adapter: "generic",
        pendingQuestion: {
          kind: "field",
          question: result.question,
          suggested: result.suggested || "",
          confirm: result.confirm,
          profileHint: result.profileHint || profileHintForQuestion(result.question),
        },
        progress: { step: 3, total: 5, action: "waiting for you on company site" },
        updatedAt: Date.now(),
      });
      await info("Company-site user input required", { jobId: job.id, question: result.question });
      // Keep the tab open and bring it to front so the user sees exactly where to type.
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
      return result;
    }
    if (result?.blocked) {
      await saveSession({
        ...(await loadSession()),
        state: STATES.BLOCKED,
        tabId,
        adapter: "generic",
        lastError: result.reason,
        pendingQuestion: { kind: "blocked", question: result.reason, reason: result.reason },
        updatedAt: Date.now(),
      });
      await warn("Company-site application blocked", { jobId: job.id, reason: result.reason });
      return result;
    }
    if (result?.submitted) {
      await chrome.tabs.remove(tabId).catch(() => {});
      await saveSession({ ...emptySession(), state: STATES.COMPLETED, updatedAt: Date.now() });
      return result;
    }
    await chrome.tabs.remove(tabId).catch(() => {});
    await saveSession({ ...emptySession(), state: STATES.FAILED, lastError: result?.reason, updatedAt: Date.now() });
    await warn("Company-site application did not complete", { jobId: job.id, reason: result?.reason });
    return result || { submitted: false, reason: "No result from the company-site adapter." };
  } catch (error) {
    await chrome.tabs.remove(tabId).catch(() => {});
    throw error;
  }
}

async function refreshPendingProfileAnswer() {
  const session = await loadSession();
  const pending = session.pendingQuestion;
  if (!pending?.question || !pending.profileHint) return { ok: true, pending: false };
  const profile = await getProfile();
  const resolved = await resolveAnswer(pending.question, undefined, profile);
  if (!resolved?.answer) return { ok: true, pending: true, suggested: false };
  await saveSession({
    ...session,
    pendingQuestion: {
      ...pending,
      suggested: resolved.answer,
      confirm: resolved.action === "CONFIRM",
    },
    updatedAt: Date.now(),
  });
  return { ok: true, pending: true, suggested: true, confirm: resolved.action === "CONFIRM" };
}

async function enableExternalSiteAndContinue() {
  const session = await loadSession();
  const pending = session.pendingQuestion;
  if (pending?.kind !== "external_permission" || !pending.externalOrigin || !pending.externalUrl) {
    return { ok: false, error: "no company-site permission is pending" };
  }
  // The request is initiated by the side-panel button, so Chrome shows the
  // exact company origin before granting access.
  const granted = await chrome.permissions.request({ origins: [pending.externalOrigin] });
  if (!granted) {
    await info("Company-site permission declined", { origin: pending.externalOrigin });
    return { ok: false, error: "permission was not granted" };
  }
  const queue = await get("queue", []);
  const job = queue.find((item) => item.id === session.jobId);
  if (!job) return { ok: false, error: "job is no longer in the queue" };
  await info("Company-site permission granted", { jobId: job.id, origin: pending.externalOrigin });
  const result = await beginExternalApplication(job, pending.externalUrl);
  job.result = result;
  job.status = result?.submitted ? "submitted"
    : result?.waitingForUser ? "waiting_for_user"
    : result?.blocked ? "blocked"
    : "needs_review";
  if (result?.submitted) {
    const traceExt = { stage: "enableExternalSiteAndContinue_recordSubmit_called", site: "generic", jobId: job.id, title: job.title, company: job.company, url: job.url };
    console.log("[APPLY_TRACE]", JSON.stringify(traceExt));
    await persistApplyTrace(traceExt);
    await recordSubmit({ ...job, site: "generic" });
  } else {
    const traceExtFalse = { stage: "enableExternalSiteAndContinue_result_false", site: "generic", jobId: job.id, title: job.title, company: job.company, url: job.url, reason: result?.reason };
    console.log("[APPLY_TRACE]", JSON.stringify(traceExtFalse));
    await persistApplyTrace(traceExtFalse);
  }
  await set("queue", queue);
  return { ok: true, result };
}

async function skipWaitingJob() {
  const session = await loadSession();
  const queue = await get("queue", []);
  const job = queue.find((j) => j.id === session.jobId);
  if (job) {
    job.status = "skipped";
    job.result = { reason: session.lastError || "skipped by user" };
  }
  if (session.tabId) await chrome.tabs.remove(session.tabId).catch(() => {});
  await set("queue", queue);
  await saveSession({ ...emptySession(), state: STATES.SKIPPED, updatedAt: Date.now() });
  await chrome.alarms.create(TICK, { when: Date.now() + 1500 });
  await info("User skipped job", { jobId: session.jobId });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "START":  await startRun();            return sendResponse({ ok: true });
      case "STOP":   await stopRun();             return sendResponse({ ok: true });
      case "PAUSE":  await pauseRun();            return sendResponse({ ok: true });
      case "RESUME": await resumeRun();           return sendResponse({ ok: true });
      case "STATS":  return sendResponse(await stats());
      case "RECORD_SUBMIT":
        const traceRecSub = { stage: "RECORD_SUBMIT_handler", payload: msg.payload };
        console.log("[APPLY_TRACE]", JSON.stringify(traceRecSub));
        await persistApplyTrace(traceRecSub);
        await recordSubmit(msg.payload);
        const traceRecSubStats = { stage: "stats_after_submit", stats: await stats() };
        console.log("[APPLY_TRACE]", JSON.stringify(traceRecSubStats));
        await persistApplyTrace(traceRecSubStats);
        return sendResponse({ ok: true });
      case "GET_SESSION":
        return sendResponse({
          ok: true,
          session: await loadSession(),
          queue: await get("queue", []),
          log: await getLog(40),
        });
      case "USER_ANSWER":
        return sendResponse(await userAnswerAndContinue(msg.answer));
      case "PROFILE_UPDATED":
        return sendResponse(await refreshPendingProfileAnswer());
      case "ENABLE_EXTERNAL_SITE":
        return sendResponse(await enableExternalSiteAndContinue());
      case "SKIP_JOB":
        return sendResponse(await skipWaitingJob());
      case "DELETE_DATA":
        await deleteAllUserData();
        return sendResponse({ ok: true });

  
    case "FOCUS_TAB": {
      // Bring the current agent tab to the foreground (user wants to see where it paused).
      const fSession = await loadSession();
      if (fSession.tabId) {
        await chrome.tabs.update(fSession.tabId, { active: true }).catch(() => {});
        return sendResponse({ ok: true });
      }
      return sendResponse({ ok: false, error: "no active tab in session" });
    }
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
      // A job on Naukri or LinkedIn often opens the company's own application
      // in a NEW tab. A content script cannot see or drive another tab, so the
      // takeover session asks the worker to run the application there and
      // report back. The user watches it happen: the tab is focused, never
      // hidden, and it is closed only if the worker opened it.

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
        // Before the agent opens a job: does it fit the candidate at all?
        const profile = await getProfile();
        if (!profile?._validation?.ok) {
          return sendResponse({
            ok: false,
            error: "Complete and save a valid candidate profile first: the agent only applies to jobs that match it.",
          });
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
      // URL must be http(s), so a `javascript:` URL can never be navigated to.

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
              const created = await chrome.tabs.create({ url, active: true });
              // The agent follows the application into the new tab.
              await saveSession({ ...(await loadSession()), tabId: created.id, updatedAt: Date.now() });
              return sendResponse({ ok: true, tabId: created.id });
            }
            case "switch_tab": {
              const session = await loadSession();
              const target = msg.tabId || session.tabId;
              if (!target) return sendResponse({ ok: false, error: "no tab to switch to" });
              await chrome.tabs.update(target, { active: true });
              return sendResponse({ ok: true, tabId: target });
            }
            case "close_tab": {
              // Refuse to close the tab the run depends on; that would strand
              // the session with no way back to the application.
              const session = await loadSession();
              if (tabId && tabId === session.tabId) {
                return sendResponse({ ok: false, error: "refused: this is the active application tab" });
              }
              if (!tabId) return sendResponse({ ok: false, error: "no originating tab" });
              await chrome.tabs.remove(tabId);
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

      case "SCRAPE": {
        // The application queue is candidate-specific. Do not turn a generic
        // search page into a list of jobs that the profile already rules out.
        const profile = await getProfile();
        if (!profile?._validation?.ok) {
          return sendResponse({
            ok: false,
            error: "Complete and save a valid candidate profile before searching for jobs.",
          });
        }
        const tab = await chrome.tabs.create({ url: msg.url, active: false });
        try {
          await waitForTab(tab.id);
          const platform = platformFromUrl(msg.url);
          const r = await chrome.tabs.sendMessage(tab.id, { type: platform.scrapeMessage });
          if (!r || !r.ok) throw new Error((r && r.error) || "scrape failed");
          // Migration for earlier versions: skipped jobs were stored in queue.
          // Remove them so a later profile correction permits a fresh search.
          const queue = (await get("queue", [])).filter((job) => job.status !== "skipped");
          const settings = await getSettings();
          const unique = r.jobs.filter((job) => !duplicateOf(queue, job));
          const evaluated = unique.map((job) => {
            const ev = evaluateJob(job, profile, {
              minRelevance: settings.governor.minRelevance,
              preferences: settings.preferences,
            });
            return {
              ...job,
              // REVIEW is retained for the user but is never picked by the
              // automatic runner; only APPLY candidates start as "ready".
              status: ev.decision === "APPLY" ? "ready" : "review",
              relevance: ev.relevance,
              match_score: ev.match_score,
              evaluation: ev,
              reasons: ev.reasons,
            };
          });
          const filtered = evaluated.filter((job) => job.evaluation.decision === "SKIP");
          let added = evaluated.filter((job) => job.evaluation.decision !== "SKIP");
          if (profile) {
            const short = added.filter((j) => j.status === "ready" && j.relevance >= 0.35);
            if (short.length) {
              const ranked = await modelRerank(short, profile, askJSON);
              const byId = new Map(ranked.map((j) => [j.id, j]));
              added = added.map((j) => byId.get(j.id) || j);
            }
          }
          added.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
          await set("queue", queue.concat(added));
          const review = added.filter((job) => job.status === "review").length;
          await info("Jobs filtered for candidate", {
            seen: r.jobs.length,
            duplicate: r.jobs.length - unique.length,
            filtered: filtered.length,
            added: added.length,
            review,
          });
          return sendResponse({
            ok: true,
            added: added.length,
            review,
            filtered: filtered.length,
            duplicate: r.jobs.length - unique.length,
            seen: r.jobs.length,
          });
        } finally {
          await chrome.tabs.remove(tab.id).catch(() => {});
        }
      }

      case "UPLOAD_RESUME":  return sendResponse({ ok: true, ...(await storeResume(msg.file)) });
      case "PARSE_RESUME":   return sendResponse({ ok: true, profile: await parseResume() });
      case "ANOMALY": await halt(msg.reason);     return sendResponse({ ok: true });
      default: return sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true;   // keep the channel open for the async reply
});
