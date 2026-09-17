// The few facts about specific job boards that the agent cannot work out by
// looking at a page.
//
// This file is deliberately almost empty, and should stay that way: an
// application is found by what a page offers, not by which site it is on.
// Something belongs here only when a board does something invisible — a
// redirect, a bookkeeping page — that no amount of reading the DOM reveals.

/**
 * Is this the job board's own record of an apply click, rather than an
 * application?
 *
 * Naukri's "Apply on company site" does two things at once: it opens the
 * company's own page in a new tab, and it sends the tab the button was in to
 * `myapply/showAcp`, which records the click and offers nothing to apply
 * with. The agent must not try to apply on such a page — there is no form,
 * so it reports that it found no apply control and gives up on the job while
 * the real application sits untouched in the other tab.
 *
 * The page may be closed once it has loaded: by then the board has recorded
 * the click. The application itself still has to be completed on the
 * company's site.
 */
export function isApplicationReceiptUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!/(^|\.)naukri\.com$/i.test(u.hostname)) return false;
  // Only the external-apply receipt. `myapply/saveApply` is Naukri's own
  // confirmation that an application on Naukri itself went through, and the
  // Naukri adapter reads it as proof of submission.
  return /\/myapply\/showacp\b/i.test(u.pathname) ||
         u.searchParams.has("multiApplyResp");
}

/** Blockers the agent must not interact with. */
export function classifyPageBlocker(signals = {}) {
  if (signals.captcha) {
    return { blocked: true, reason: "Bot/security verification detected. The agent will not attempt to bypass this check." };
  }
  if (signals.login) {
    return { blocked: true, reason: "Login or session challenge on this page." };
  }
  if (signals.accessDenied) {
    return { blocked: true, reason: "Access denied." };
  }
  if (signals.cloudflare) {
    return { blocked: true, reason: "Cloudflare or similar security interstitial." };
  }
  return { blocked: false };
}
