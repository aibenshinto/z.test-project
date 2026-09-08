// Orchestrator. The service worker is evicted after ~30s idle, so the run loop
// is driven by chrome.alarms + storage, never by setTimeout or module state.

import { getSettings, get, set } from "../lib/storage.js";
import { canSubmit, recordSubmit, halt, clearHalt, stats, randomDelay } from "./governor.js";
import { resolve as resolveAnswer } from "../lib/answer-bank.js";
import { getResume, getProfile, parseResume, storeResume } from "../lib/resume.js";
import { heuristicScore, modelRerank } from "../lib/ranker.js";
import { askJSON } from "../lib/llm/index.js";

const TICK = "autoapply-tick";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === TICK) await tick();
});

export async function startRun() {
  await clearHalt();
  await chrome.alarms.create(TICK, { periodInMinutes: 1 });
  await tick();
}

export async function stopRun(reason = "stopped by user") {
  await chrome.alarms.clear(TICK);
  await halt(reason);
}

// One unit of work per tick: take the highest-ranked queued job and try it.
async function tick() {
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
  const next = queue
    .filter((j) => j.status === "ready" && j.relevance >= settings.governor.minRelevance)
    .sort((a, b) => b.relevance - a.relevance)[0];

  if (!next) return;

  try {
    const result = await applyToJob(next);
    next.status = result.submitted ? "submitted" : "needs_review";
    next.result = result;

    // Only a page-state-confirmed submission counts. See selectors.js.
    if (result.submitted) await recordSubmit({ site: next.site, jobId: next.id });

    // The driver halts the whole run when the failure will repeat for every
    // job in the queue (incomplete profile, redirect to profile completion).
    if (result.halt) {
      await set("queue", queue);
      return halt(result.reason);
    }
  } catch (err) {
    next.status = "error";
    next.error = String(err);
    // A provider outage is not a detection event - never trip the breaker on it.
    if (err && err.retryable) {
      console.warn("[tick] provider unavailable, will retry next tick:", err.message);
      next.status = "ready";
      await set("queue", queue);
      return chrome.alarms.create(TICK, { when: Date.now() + 120000 });
    }

    // Anything that smells like detection stops the whole run immediately.
    if (/captcha|verify|blocked|unexpected dom/i.test(String(err))) {
      await halt(`anomaly on ${next.id}: ${err}`);
    }
  }

  await set("queue", queue);
  await chrome.alarms.create(TICK, {
    when: Date.now() + randomDelay(settings.governor),
  });
}

// Opens the posting in a tab and hands control to that site's content adapter.
async function applyToJob(job) {
  const tab = await chrome.tabs.create({ url: job.url, active: false });
  try {
    await waitForTab(tab.id);
    return await chrome.tabs.sendMessage(tab.id, { type: "APPLY", job });
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "START":  await startRun();            return sendResponse({ ok: true });
      case "STOP":   await stopRun();             return sendResponse({ ok: true });
      case "STATS":  return sendResponse(await stats());

      // Content-script bridges: keys and the answer bank live only here.
      case "GET_APPLY_CONTEXT":
        return sendResponse({
          ok: true,
          profile: await getProfile(),
          resume: await getResume(),
        });

      case "RESOLVE_ANSWER": {
        const profile = await getProfile();
        const hit = await resolveAnswer(msg.question, msg.options, profile);
        return sendResponse({ ok: true, answer: hit && hit.answer, source: hit && hit.source });
      }

      case "SCRAPE": {
        const tab = await chrome.tabs.create({ url: msg.url, active: false });
        try {
          await waitForTab(tab.id);
          const r = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_PAGE" });
          if (!r || !r.ok) throw new Error((r && r.error) || "scrape failed");
          const queue = await get("queue", []);
          const seen = new Set(queue.map((j) => j.id));
          const profile = await getProfile();
          let added = r.jobs.filter((j) => !seen.has(j.id)).map((j) => {
            const h = profile ? heuristicScore(j, profile) : { score: 0, reasons: ["no profile"] };
            return { ...j, status: "ready", relevance: h.score, reasons: h.reasons };
          });
          // Rerank only the plausible ones, and only if a key is configured.
          if (profile) {
            const short = added.filter((j) => j.relevance >= 0.35);
            if (short.length) {
              const ranked = await modelRerank(short, profile, askJSON);
              const byId = new Map(ranked.map((j) => [j.id, j]));
              added = added.map((j) => byId.get(j.id) || j);
            }
          }
          added.sort((a, b) => b.relevance - a.relevance);
          await set("queue", queue.concat(added));
          return sendResponse({ ok: true, added: added.length, seen: r.jobs.length });
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
