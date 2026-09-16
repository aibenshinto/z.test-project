// Message bridge for LinkedIn discovery and the AI-driven Easy Apply adapter.

/* global linkedinScrape, linkedinCheckAnomaly, LINKEDIN_SEL, linkedinApply */

const LINKEDIN_MESSAGES = new Set(["SCRAPE_PAGE", "PROBE", "APPLY", "CONTINUE_APPLY"]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Leave every other message to its own listener: the first reply wins, and
  // an "unknown message" reply here would pre-empt the takeover listener.
  if (!LINKEDIN_MESSAGES.has(msg?.type)) return false;

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
      }
    } catch (error) {
      return sendResponse({ ok: false, error: String(error?.message || error) });
    }
  })();
  return true; // keep channel open for async response
});
