// LinkedIn selectors. UNVERIFIED against production — treat as best-effort.
// Prefer semantic attributes over hashed class names.

const SEL = {
  search: {
    resultCard: ".job-card-container, li.jobs-search-results__list-item, [data-job-id]",
    jobIdAttr: "data-job-id",
    cardTitle: ".job-card-list__title, .artdeco-entity-lockup__title a",
    cardCompany: ".job-card-container__primary-description, .artdeco-entity-lockup__subtitle",
    cardLocation: ".job-card-container__metadata-item, .job-card-container__metadata-wrapper li",
    cardLink: "a.job-card-list__title, a.job-card-container__link, a[href*='/jobs/view/']",
  },
  job: {
    easyApply: () => [...document.querySelectorAll("button, [role='button']")].find((el) =>
      visible(el) && /easy apply/i.test(`${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`)
    ) || null,
    externalApply: () => [...document.querySelectorAll("a, button, [role='button']")].find((el) =>
      visible(el) && /apply on company|external application|company site/i.test(`${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`)
    ) || null,
    description: ".jobs-description, #job-details",
  },
  form: {
    dialog: "div[role='dialog'], .jobs-easy-apply-modal",
    completion: ".artdeco-inline-feedback--success, [data-test-easy-apply-success], [role='alert']",
  },
  anomaly: {
    captcha: "iframe[src*='recaptcha/api2/bframe'], iframe[src*='hcaptcha'], #captcha-internal",
    login: ".auth-wall, .join-form, input#username",
    challenge: "[class*='challenge'], iframe[src*='checkpoint']",
  },
};

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

function checkAnomaly() {
  const A = SEL.anomaly;
  if ([...document.querySelectorAll(A.captcha)].some(visible)) return "visible CAPTCHA challenge";
  if ([...document.querySelectorAll(A.challenge)].some(visible)) return "security checkpoint";
  if (/\/checkpoint|\/uas\/login|\/login/i.test(location.pathname) && document.querySelector(A.login)) {
    return "not authenticated - LinkedIn login wall";
  }
  return null;
}

globalThis.LINKEDIN_SEL = SEL;
globalThis.linkedinCheckAnomaly = checkAnomaly;
globalThis.linkedinVisible = visible;
