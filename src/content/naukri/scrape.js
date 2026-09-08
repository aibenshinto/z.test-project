// Naukri search-results scraper. Classic content script - shares global scope
// with selectors.js, which must be listed before it in the manifest.

/* global NAUKRI_SEL, naukriWaitFor */

const text = (root, sel) => {
  const el = root.querySelector(sel);
  return el ? el.innerText.trim().replace(/\s+/g, " ") : null;
};

/** Detects the states that must stop a run rather than be retried. */
function checkAnomaly() {
  const A = NAUKRI_SEL.anomaly;
  if (A.registrationRedirect.test(location.pathname)) {
    return "not authenticated - Naukri redirected to the registration funnel";
  }
  if (document.querySelector(A.captcha)) return "visible CAPTCHA challenge";
  if (document.querySelector(A.rateLimit)) return "rate limited";
  return null;
}

function parseCard(card) {
  const S = NAUKRI_SEL.search;
  const link = card.querySelector(S.cardLink);
  if (!link) return null;

  return {
    id:         card.getAttribute(S.jobIdAttr),
    site:       "naukri",
    title:      text(card, S.cardTitle),
    company:    text(card, S.cardCompany),
    // pathname only: the query string carries tracking params we do not want
    // in storage, and they break dedupe by making the same job look distinct.
    url:        new URL(link.href).origin + new URL(link.href).pathname,
    experience: text(card, S.cardExperience),
    location:   text(card, S.cardLocation),
    salary:     text(card, S.cardSalary),        // frequently null - not an error
    summary:    text(card, S.cardSummary),
    tags:       [...card.querySelectorAll(S.cardTags)].map((t) => t.innerText.trim()),
    postedOn:   text(card, S.cardPostedOn),
    scrapedAt:  Date.now(),
    status:     "scraped",
  };
}

/** Scrape the current results page. */
async function scrapePage() {
  const anomaly = checkAnomaly();
  if (anomaly) throw new Error(anomaly);

  await naukriWaitFor(NAUKRI_SEL.search.resultCard);

  // Re-query rather than holding handles: this list re-hydrates under us.
  const cards = [...document.querySelectorAll(NAUKRI_SEL.search.resultCard)];
  const jobs = cards.map(parseCard).filter(Boolean);

  return { jobs, hasNext: Boolean(NAUKRI_SEL.search.pagerNext()) };
}

/** Advance to the next results page. Resolves once the list has re-rendered. */
async function nextPage() {
  const next = NAUKRI_SEL.search.pagerNext();
  if (!next) return false;

  const firstBefore = document
    .querySelector(NAUKRI_SEL.search.resultCard)
    ?.getAttribute(NAUKRI_SEL.search.jobIdAttr);

  next.click();

  // The URL does not always change, so wait for the first card's id to differ.
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 300));
    const now = document
      .querySelector(NAUKRI_SEL.search.resultCard)
      ?.getAttribute(NAUKRI_SEL.search.jobIdAttr);
    if (now && now !== firstBefore) return true;
  }
  return false;
}

globalThis.naukriScrape = { scrapePage, nextPage, checkAnomaly, parseCard };
