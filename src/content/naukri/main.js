// Message bridge between the service worker and the Naukri page adapters.

/* global naukriScrape, naukriApply */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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

        default:
          return sendResponse({ ok: false, error: "unknown message " + msg.type });
      }
    } catch (err) {
      // Surface anomalies to the governor so it can trip the breaker.
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true;   // async reply
});
