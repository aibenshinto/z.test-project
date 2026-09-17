// Choosing which frame of a page holds the application.
//
// A company careers page very often does not host its own application: it
// embeds Greenhouse, Lever, Workday or Ashby in an iframe. The page the agent
// is reading then offers no way to apply at all, because the form is in a
// document the top frame cannot see.
//
// The worker asks every frame what it can see and brings the answers here.
// This module decides, and stays pure so the decision is testable — the
// asking, which needs Chrome, lives in the service worker.

/** States that mean a frame is showing an application, in order of certainty. */
const OPEN = new Set(["applying", "questionnaire", "chatbot"]);
const OFFERED = new Set(["ready"]);

function isHttp(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch (_) {
    return false;
  }
}

/**
 * Which frame should the application be driven in?
 *
 * @param {Array<{frameId: number, url: string, state: string, fields: number}>} probes
 *   One entry per frame that answered, `frameId` 0 being the page itself.
 * @returns {{frameId: number, url: string, state: string} | null}
 *   The frame to drive, or null when no frame holds an application.
 */
export function pickApplicationFrame(probes) {
  const candidates = (probes || []).filter((probe) =>
    probe &&
    // Frame 0 is the page the agent has already read; if the application were
    // there it would not be asking.
    probe.frameId > 0 &&
    // An ad, a tracker or a chat widget is a frame too. Only a frame that says
    // it is showing or offering an application is a candidate, and a blank or
    // javascript: frame is never one.
    isHttp(probe.url) &&
    (OPEN.has(probe.state) || OFFERED.has(probe.state)));

  if (!candidates.length) return null;

  // An application already open beats one that is merely offered, and between
  // two of a kind, the one with more of a form in it.
  const rank = (probe) => (OPEN.has(probe.state) ? 2 : 1);
  candidates.sort((a, b) =>
    rank(b) - rank(a) ||
    (Number(b.fields) || 0) - (Number(a.fields) || 0) ||
    a.frameId - b.frameId);

  return candidates[0];
}
