// Rate governor and kill switch. This is what stands between "useful" and
// "account restricted" - every submit must pass through canSubmit().

import { getSettings, get, set } from "../lib/storage.js";

const LOG_KEY = "submitLog";   // [{ at, site, jobId }]

const HOUR = 3600_000;
const DAY  = 86_400_000;

async function recent() {
  const log = await get(LOG_KEY, []);
  const cutoff = Date.now() - DAY;
  const trimmed = log.filter((e) => e.at > cutoff);
  if (trimmed.length !== log.length) await set(LOG_KEY, trimmed);
  return trimmed;
}

/**
 * @returns {Promise<{ok: boolean, reason?: string, waitMs?: number}>}
 */
export async function canSubmit() {
  const { governor } = await getSettings();

  if (!governor.enabled) return { ok: false, reason: "kill switch is off" };
  if (await get("haltedAt")) return { ok: false, reason: await get("haltReason") };

  const log = await recent();
  const now = Date.now();

  const today = log.length;
  if (today >= governor.maxPerDay) {
    return { ok: false, reason: `daily cap reached (${governor.maxPerDay})` };
  }

  const lastHour = log.filter((e) => e.at > now - HOUR).length;
  if (lastHour >= governor.maxPerHour) {
    const oldest = Math.min(...log.filter((e) => e.at > now - HOUR).map((e) => e.at));
    return { ok: false, reason: "hourly cap reached", waitMs: oldest + HOUR - now };
  }

  const last = log.length ? Math.max(...log.map((e) => e.at)) : 0;
  const gap = now - last;
  const required = randomDelay(governor);
  if (last && gap < required) {
    return { ok: false, reason: "pacing", waitMs: required - gap };
  }

  return { ok: true };
}

export function randomDelay({ minDelayMs, maxDelayMs }) {
  return minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
}

export async function recordSubmit(jobData) {
  const log = await recent();
  log.push({
    at: Date.now(),
    site: jobData.site,
    jobId: jobData.jobId || jobData.id,
    title: jobData.title,
    company: jobData.company,
    url: jobData.url
  });
  await set(LOG_KEY, log);
}

/** Trip the breaker. Nothing submits again until the user clears it. */
export async function halt(reason) {
  await set("haltedAt", Date.now());
  await set("haltReason", reason);
  await chrome.alarms.clearAll();
  console.warn("[governor] HALTED:", reason);
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
}

export async function clearHalt() {
  await chrome.storage.local.remove(["haltedAt", "haltReason"]);
  chrome.action.setBadgeText({ text: "" });
}

export async function stats() {
  const log = await recent();
  const now = Date.now();
  return {
    today: log.length,
    lastHour: log.filter((e) => e.at > now - HOUR).length,
    halted: Boolean(await get("haltedAt")),
    haltReason: await get("haltReason"),
  };
}
