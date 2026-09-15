// Debug capture store (service-worker side).
//
// Holds click diagnostics and, when debug mode is enabled, the before/after
// screenshots and DOM snapshots for interactions that failed. Everything lives
// in chrome.storage.local under bounded keys so a long run cannot fill the
// profile's disk quota.
//
// Screenshots are captured ONLY for failures and ONLY while debug mode is on
// (Part 15), because a data-URL PNG is ~100-400 KB and capturing one per action
// would be both slow and wasteful.

import { get, set } from "./storage.js";

const DIAG_KEY = "clickDiagnostics";
const CAPTURE_KEY = "debugCaptures";
const DEBUG_KEY = "debugMode";

/** Keep the most recent N diagnostics; older ones are dropped. */
const MAX_DIAGNOSTICS = 200;
/** Screenshots are large — keep far fewer. */
const MAX_CAPTURES = 20;

export async function isDebugEnabled() {
  return Boolean(await get(DEBUG_KEY, false));
}

export async function setDebugEnabled(on) {
  await set(DEBUG_KEY, Boolean(on));
  return Boolean(on);
}

// chrome.storage has no atomic read-modify-write. A click ladder can emit
// several records within one storage round-trip, and two concurrent
// get→push→set sequences would silently drop one — exactly when the records
// are most needed. Chaining them keeps each append serialized.
let writeChain = Promise.resolve();

function serialize(work) {
  const next = writeChain.then(work, work);
  // Keep the chain alive even if one write rejects.
  writeChain = next.catch(() => {});
  return next;
}

/**
 * Persist one interaction diagnostic record.
 * @param {object} record  The structured record from the content script
 */
export async function recordDiagnostic(record) {
  await serialize(async () => {
    const all = await get(DIAG_KEY, []);
    all.push({ ...record, storedAt: Date.now() });
    if (all.length > MAX_DIAGNOSTICS) all.splice(0, all.length - MAX_DIAGNOSTICS);
    await set(DIAG_KEY, all);
  });
  return record;
}

export async function getDiagnostics(limit = 50) {
  const all = await get(DIAG_KEY, []);
  return all.slice(-limit).reverse();
}

export async function clearDiagnostics() {
  await set(DIAG_KEY, []);
  await set(CAPTURE_KEY, []);
}

/**
 * Capture the visible area of a tab as a PNG data URL.
 *
 * Returns null rather than throwing: a capture failure (tab not active, page
 * still loading, quota hit) must never break the agent run.
 *
 * @param {number} [windowId]
 * @returns {Promise<string|null>}
 */
export async function captureViewport(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
      format: "png",
    });
  } catch (_) {
    return null;
  }
}

/**
 * Capture a screenshot for the LLM, as { mime, b64 } matching the LLM router's
 * existing multimodal `file` convention.
 *
 * @param {number} [windowId]
 * @returns {Promise<{mime: string, b64: string}|null>}
 */
export async function captureForModel(windowId) {
  const dataUrl = await captureViewport(windowId);
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const mime = /data:([^;]+)/.exec(dataUrl)?.[1] || "image/png";
  return { mime, b64: dataUrl.slice(comma + 1) };
}

/**
 * Store a full debug bundle for a failed interaction: the diagnostic record,
 * before/after screenshots, and a DOM snapshot.
 *
 * Mirrors the layout described in Part 15, keyed by a per-failure id:
 *   click-<ISO date>-<seq>-before.png
 *   click-<ISO date>-<seq>-after.png
 *   click-<ISO date>-<seq>.json
 *
 * @param {object} params
 * @returns {Promise<{id: string} | null>}
 */
export async function storeFailureCapture({ record, before, after, domSnapshot, url, title }) {
  if (!(await isDebugEnabled())) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const id = `click-${stamp}-${String(record?.seq ?? 0).padStart(3, "0")}`;

  const bundle = {
    id,
    files: {
      before: `${id}-before.png`,
      after: `${id}-after.png`,
      json: `${id}.json`,
    },
    json: {
      url: url || record?.beforeState?.url || null,
      title: title || null,
      target: record?.target || null,
      targetText: record?.targetText || null,
      action: record?.action || null,
      method: record?.method || null,
      elementMetadata: {
        visible: record?.visible ?? null,
        enabled: record?.enabled ?? null,
        rect: record?.rect || null,
      },
      beforeState: record?.beforeState || null,
      afterState: record?.afterState || null,
      result: record?.result || null,
      error: record?.error || null,
      retryCount: record?.retryCount ?? 0,
      attempts: record?.attempts || [],
      domSnapshot: domSnapshot || null,
    },
    screenshots: { before: before || null, after: after || null },
    storedAt: Date.now(),
  };

  await serialize(async () => {
    const all = await get(CAPTURE_KEY, []);
    all.push(bundle);
    if (all.length > MAX_CAPTURES) all.splice(0, all.length - MAX_CAPTURES);
    await set(CAPTURE_KEY, all);
  });
  return { id };
}

export async function getCaptures(limit = 10) {
  const all = await get(CAPTURE_KEY, []);
  return all.slice(-limit).reverse();
}
