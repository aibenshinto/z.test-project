// Message bridge for LinkedIn discovery and the bounded Easy Apply adapter.

/* global linkedinScrape, linkedinCheckAnomaly, LINKEDIN_SEL */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "SCRAPE_PAGE":
          return sendResponse({ ok: true, ...(await linkedinScrape.scrapePage()) });

        case "PROBE":
          return sendResponse({ ok: true, anomaly: linkedinCheckAnomaly() });

        case "APPLY": {
          return sendResponse({ ok: true, ...(await linkedinApply.apply(msg.job)) });
          const anomaly = linkedinCheckAnomaly();
          if (anomaly) return sendResponse({ ok: true, blocked: true, reason: anomaly });
          if (document.querySelector(LINKEDIN_SEL.job.externalApply)) {
            return sendResponse({
              ok: true,
              external: true,
              reason: "External company application — generic form adapter is not enabled for this origin.",
            });
          }
          if (document.querySelector(LINKEDIN_SEL.job.easyApply)) {
            return sendResponse({
              ok: true,
              submitted: false,
              manual: true,
              reason: "LinkedIn Easy Apply is discovery-only until its form extractor is verified.",
            });
          }
          return sendResponse({ ok: true, submitted: false, manual: true, reason: "No verified LinkedIn Apply action found." });
        }

        case "CONTINUE_APPLY":
          return sendResponse({ ok: true, ...(await linkedinApply.apply(msg.job)) });
          return sendResponse({ ok: true, submitted: false, manual: true, reason: "LinkedIn application requires manual review." });

        default:
          return sendResponse({ ok: false, error: `unknown message ${msg.type}` });
      }
    } catch (error) {
      return sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  return true;
});
