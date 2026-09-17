// Platform registry. The worker looks up an adapter by job.site or tab URL.
// Content scripts still own DOM; this module only routes intent.

export const PLATFORMS = {
  naukri: {
    id: "naukri",
    hostRe: /naukri\.com$/i,
    scrapeMessage: "SCRAPE_PAGE",
    applyMessage: "APPLY",
    continueMessage: "CONTINUE_APPLY",
  },
  linkedin: {
    id: "linkedin",
    hostRe: /linkedin\.com$/i,
    scrapeMessage: "SCRAPE_PAGE",
    applyMessage: "APPLY",
    continueMessage: "CONTINUE_APPLY",
  },
  generic: {
    id: "generic",
    hostRe: /.*/,
    scrapeMessage: "SCRAPE_PAGE",
    applyMessage: "APPLY",
    continueMessage: "CONTINUE_APPLY",
  },
};

export function platformFromUrl(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { return PLATFORMS.generic; }
  if (/naukri\.com$/i.test(host) || host.endsWith(".naukri.com")) return PLATFORMS.naukri;
  if (/linkedin\.com$/i.test(host) || host.endsWith(".linkedin.com")) return PLATFORMS.linkedin;
  return PLATFORMS.generic;
}

export function platformFromJob(job) {
  if (job?.site && PLATFORMS[job.site]) return PLATFORMS[job.site];
  return platformFromUrl(job?.url || "");
}

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
