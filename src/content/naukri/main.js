// Message bridge between the service worker and the Naukri page adapters.

/* global naukriScrape, naukriApply */

const NAUKRI_MESSAGES = new Set([
  "SCRAPE_PAGE", "NEXT_PAGE", "APPLY", "CONTINUE_APPLY", "OPEN_EXTERNAL_COMPANY_SITE", "PROBE",
]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Leave every other message to its own listener. Several listeners share a
  // Naukri tab, and the first reply wins: answering "unknown message" here
  // beat the takeover listener's real, asynchronous reply to TAKEOVER_START
  // and TAKEOVER_APPLY_HERE.
  if (!NAUKRI_MESSAGES.has(msg?.type)) return false;

  (async () => {
    try {
      switch (msg.type) {
        case "SCRAPE_PAGE":
          return sendResponse({ ok: true, ...(await naukriScrape.scrapePage()) });

        case "NEXT_PAGE":
          return sendResponse({ ok: true, advanced: await naukriScrape.nextPage() });

        case "APPLY":
          return sendResponse({ ok: true, ...(await naukriApply.apply(msg.job)) });

        case "CONTINUE_APPLY":
          return sendResponse({ ok: true, ...(await naukriApply.continueApply(msg.job, msg.answer)) });

        case "OPEN_EXTERNAL_COMPANY_SITE":
          return sendResponse({ ok: true, ...naukriApply.openExternalCompanySite() });

        case "PROBE":
          return sendResponse({ ok: true, anomaly: naukriScrape.checkAnomaly() });
      }
    } catch (err) {
      // Surface anomalies to the governor so it can trip the breaker.
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;   // async reply
});
