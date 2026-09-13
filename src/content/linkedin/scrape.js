// LinkedIn scrape — best-effort. Cards that fail to parse are dropped.

/* global LINKEDIN_SEL, linkedinCheckAnomaly */

const text = (root, sel) => {
  const el = root.querySelector(sel);
  return el ? el.innerText.trim().replace(/\s+/g, " ") : null;
};

function parseCard(card) {
  const S = LINKEDIN_SEL.search;
  const link = card.querySelector(S.cardLink);
  if (!link) return null;
  let url;
  try { url = new URL(link.href, location.origin); } catch { return null; }
  return {
    id: card.getAttribute(S.jobIdAttr) || url.pathname,
    site: "linkedin",
    title: text(card, S.cardTitle),
    company: text(card, S.cardCompany),
    url: url.origin + url.pathname,
    location: text(card, S.cardLocation),
    experience: null,
    salary: null,
    summary: null,
    tags: [],
    postedOn: null,
    scrapedAt: Date.now(),
    status: "scraped",
  };
}

async function scrapePage() {
  const anomaly = linkedinCheckAnomaly();
  if (anomaly) throw new Error(anomaly);
  const cards = [...document.querySelectorAll(LINKEDIN_SEL.search.resultCard)];
  const jobs = cards.map(parseCard).filter(Boolean);
  return { jobs, hasNext: false };
}

globalThis.linkedinScrape = { scrapePage, parseCard, checkAnomaly: linkedinCheckAnomaly };
