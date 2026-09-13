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
