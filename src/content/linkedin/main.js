// Message bridge for LinkedIn discovery and the AI-driven Easy Apply adapter.

/* global linkedinScrape, linkedinCheckAnomaly, LINKEDIN_SEL, linkedinApply */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {

        case "SCRAPE_PAGE":
          return sendResponse({ ok: true, ...(await linkedinScrape.scrapePage()) });

        case "PROBE":
          return sendResponse({ ok: true, anomaly: linkedinCheckAnomaly() });

        case "APPLY":
        case "CONTINUE_APPLY":
          // Both entry points delegate to the AI agent loop via linkedinApply.apply()
          return sendResponse({ ok: true, ...(await linkedinApply.apply(msg.job)) });

        default:
          return sendResponse({ ok: false, error: `unknown message type: ${msg.type}` });
      }
    } catch (error) {
      return sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  return true; // keep channel open for async response
});
