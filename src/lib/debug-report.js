// Debug report — everything needed to see why a run went wrong, as one block
// of text the user can copy from the side panel and pass on.
//
// Pure module: the panel gathers the pieces, this only formats them.
//
// The panel's own activity box shows each event's name and reason only. What
// a diagnosis needs is the rest — what the model read a page as, which step
// was waiting, when — so every event goes in here with all it recorded.
//
// Never included: API keys, the resume, the profile. Models are named by
// provider and model only.

/**
 * @param {object} p
 * @param {string} [p.version]      extension version
 * @param {string} [p.userAgent]
 * @param {object} [p.routes]       settings.llm.routes
 * @param {object} [p.run]          TAKEOVER_STATUS reply
 * @param {string} [p.panelStatus]  what the panel's run status line says
 * @param {object[]} [p.events]     event log, newest first, as stored
 * @param {object[]} [p.trace]      applyTrace, oldest first, as stored
 * @param {object[]} [p.interactions] click diagnostics, newest first
 * @param {number} [p.now]
 * @returns {string}
 */
export function buildDebugReport({
  version = "", userAgent = "", routes = {}, run = null, panelStatus = "",
  events = [], trace = [], interactions = [], now = Date.now(),
} = {}) {
  const lines = [
    "AutoApply debug log",
    `Version ${version || "?"} · copied ${when(now)}`,
    userAgent ? `Browser: ${userAgent}` : null,
    `Models: ${describeRoutes(routes)}`,
    `Run: ${run?.running ? `in progress on tab ${run.tabId}${run.paused ? " (paused)" : ""}` : "not running"}`,
    panelStatus ? `Panel status: ${oneLine(panelStatus)}` : null,
    "",
    `== Activity, oldest first (${events.length}) ==`,
    ...[...events].reverse().map((e) =>
      `${when(e.at)}  ${String(e.level || "").toUpperCase()}  ${e.message}${details(e.extra)}`),
    "",
    `== Application trace (${trace.length}) ==`,
    ...trace.map((t) => {
      const { at, ...rest } = t || {};
      return `${when(at)}  ${JSON.stringify(rest)}`;
    }),
    "",
    `== Interactions, oldest first (${interactions.length}) ==`,
    ...[...interactions].reverse().map((d) =>
      `${when(d.timestamp || d.storedAt)}  ${d.action} "${oneLine(d.targetText || d.target || "")}"` +
      ` via ${d.method} → ${d.result}` +
      `${d.retryCount ? ` after ${d.retryCount} retries` : ""}` +
      `${d.error ? ` · ${oneLine(d.error)}` : ""}` +
      `${d.beforeState?.url ? ` · ${d.beforeState.url}` : ""}`),
  ];
  return lines.filter((line) => line !== null).join("\n");
}

function describeRoutes(routes) {
  const entries = Object.entries(routes || {});
  if (!entries.length) return "not configured";
  return entries.map(([task, r]) => `${task} ${r?.provider || "?"}/${r?.model || "default"}`).join(", ");
}

function details(extra) {
  if (!extra || typeof extra !== "object" || !Object.keys(extra).length) return "";
  return `  ${JSON.stringify(extra)}`;
}

function when(at) {
  if (!at) return "?";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "?" : d.toLocaleString();
}

function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}
