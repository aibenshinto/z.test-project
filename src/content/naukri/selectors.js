// Naukri selectors.
//
// VERIFIED = read off the live DOM in an authenticated session, 2026-09-08.
// UNVERIFIED = still a guess.
//
// Two distinct naming regimes on this site, and they need different treatment:
//   * Search results page  -> semantic classes (.comp-name, .row3, .locWdth).
//     Durable. Anchor directly.
//   * Job detail + pagination -> CSS-module names with a build hash
//     (styles_apply-button__uJI3A). The hash CHANGES ON EVERY DEPLOY.
//     Never match one literally; use a [class*='prefix'] match, a stable
//     unhashed alias, or an id.

const SEL = {
  search: {
    // VERIFIED - 20 cards per page
    resultCard:   ".srp-jobtuple-wrapper[data-job-id]",
    jobIdAttr:    "data-job-id",
    inner:        ".cust-job-tuple",

    cardTitle:      ".row1 h2 a.title",
    cardLink:       ".row1 h2 a.title",
    cardCompany:    ".row2 .comp-dtls-wrap a.comp-name",
    cardRating:     ".row2 a.rating",
    cardExperience: ".row3 .exp-wrap .expwdth",
    cardLocation:   ".row3 .loc-wrap .locWdth",
    cardSalary:     ".row3 .sal-wrap",       // OPTIONAL: present on ~6 of 20 cards
    cardSummary:    ".row4 .job-desc",
    cardTags:       ".row5 ul.tags-gt li.tag-li",
    cardPostedOn:   ".row6 .job-post-day",

    // Pagination uses hashed module classes, so match on text, not class.
    pagerNext: () =>
      [...document.querySelectorAll("[class*='pagination'] a, a[class*='styles_btn-secondary']")]
        .find((a) => a.innerText.trim().toLowerCase() === "next") || null,
  },

  job: {
    // VERIFIED. NOTE: #apply-button appears TWICE on the page - once in the
    // sticky header, once in the body - so the id is not unique and
    // querySelector() may return the hidden one. Always pick a visible node.
    // Matches the live button exactly: <button id="apply-button"
    // class="styles_apply-button__<hash> apply-button">Apply</button>.
    applyButton:   "#apply-button.apply-button, #apply-button, button.apply-button",
    saveButton:    "[class*='styles_save-job-button']",
    description:   "[class*='JDC__dang-inner-html']",
    headerTitle:   "[class*='styles_jd-header-title']",
    headerCompany: "[class*='styles_jd-header-comp-name']",

    // VERIFIED ABSENT on an on-Naukri posting; present when the posting hands
    // off to the employer's own site. Its presence means "skip, or route to an
    // ATS adapter" - it is NOT an apply-in-place job.
    // Naukri renders this in multiple ways — match all known variants.
    externalApply: "#company-site-button, [class*='company-site'], a[data-ga-track*='apply-company'], button[data-ga-track*='company-site']",

    alreadyApplied: "[class*='applied']",   // UNVERIFIED
  },

  // VERIFIED on a live apply attempt, 2026-09-08.
  // Clicking Apply opens a right-hand "chatbot" drawer. Structure:
  //   .chatbot_Drawer.chatbot_right
  //     .chatbot_Nav > .crossIcon.chatBot.chatBot-ic-cross      (close)
  //     .chatbot_MessageContainer > ul.list
  //         li.botItem.chatbot_ListItem > .botMsg.msg           (bot question)
  //     .chatbot_SendMessageContainer
  //         .chatbot_InputContainer > .textAreaWrapper > .textArea
  questionnaire: {
    drawer:       ".chatbot_Drawer.chatbot_right",
    container:    ".chatbot_DrawerContentWrapper",
    messageList:  ".chatbot_MessageContainer ul.list",
    botMessage:   "li.botItem .botMsg",
    closeButton:  ".chatbot_Nav .crossIcon",

    // CRITICAL: .textArea is a contenteditable DIV, not an <input>.
    // Setting .value does nothing. Focus it, then either dispatch a real
    // keyboard sequence or set textContent AND fire an 'input' event so
    // React's onChange sees it.
    input:        ".chatbot_SendMessageContainer .textArea",
    inputIsContentEditable: true,

    sendContainer: ".chatbot_SendMessageContainer",
    fileInput:     ".chatbot_DrawerContentWrapper input[type=file]",
  },

  // Questions observed. Note they are TEMPLATED, which is what makes the
  // answer bank so effective here - normalise on the template, not the
  // literal string, and resolve {skill} against the profile:
  //   "How much experience do you have in {Django|Python|Flask|Pandas|Numpy}?"
  //   "What is your current location?"
  //   "What are your preferred locations?"   (up to 10 cities)
  //   "Please upload your resume"
  //   "Please write a headline for your profile of more than 50 characters"

  anomaly: {
    // VERIFIED: an unauthenticated session is redirected here ~5-10s after
    // landing on the SRP. Means "not logged in" -> HALT the run. It does not
    // mean rate limiting, so backing off and retrying is the wrong response.
    registrationRedirect: /\/registration\/createAccount/,

    // Do NOT use a broad [class*='captcha'] probe: on a healthy SRP it matches,
    // because Naukri loads reCAPTCHA assets globally. That would trip the kill
    // switch on every run. Match a visible challenge frame only.
    captcha: "iframe[src*='recaptcha/api2/bframe']",
    rateLimit: ".error-429, [class*='too-many']",   // UNVERIFIED
  },
};

// The SRP is a React list that re-hydrates after load: a handle captured in one
// tick is often detached by the next. Re-query, never cache nodes across awaits.
async function waitFor(selector, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const el = document.querySelector(selector);
    if (el) return el;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Picks the visible node when a selector matches several (see #apply-button).
function visible(selector) {
  return [...document.querySelectorAll(selector)].find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }) || null;
}

globalThis.NAUKRI_SEL = SEL;
globalThis.naukriWaitFor = waitFor;
globalThis.naukriVisible = visible;

// ---------------------------------------------------------------------------
// CRITICAL BEHAVIOUR, verified by attempting a real application 2026-09-08.
//
// Clicking #apply-button DOES NOT RELIABLY SUBMIT AN APPLICATION.
//
// If the user's Naukri profile is incomplete, the same drawer is used for a
// profile-completion flow instead ("Please upload your resume", "write a
// headline..."). Deflecting those turns the drawer into a generic job
// RECOMMENDATION bot ("Which role are you looking for?"), and the application
// is silently never submitted. In the observed run the flow ended by
// navigating to /mnjuser/profile - no application was created.
//
// Consequences for the adapter, all mandatory:
//   1. NEVER treat "the drawer opened" as success. That is the bug that makes
//      an auto-applier report dozens of applications it never sent.
//   2. Confirm submission from page state only: the visible #apply-button must
//      stop reading "Apply", or an applied marker must appear.
//   3. Detect the profile-completion questions above and HALT the run - the
//      account needs a human to fix the profile, and every further attempt in
//      that run will fail the same way.
//   4. Detect navigation away to /mnjuser/profile as the same failure.
// ---------------------------------------------------------------------------

function applicationSubmitted() {
  const btn = globalThis.naukriVisible("#apply-button, .apply-button");
  if (!btn) return false;
  if (/^applied/i.test(btn.innerText.trim())) return true;
  return Boolean(document.querySelector("[class*='already-applied'], [class*='appliedTag']"));
}

function profileIncompleteBlock() {
  const asks = [...document.querySelectorAll("li.botItem .botMsg")].map((e) => e.innerText);
  return asks.some((t) => /upload your resume|write a headline/i.test(t));
}

globalThis.naukriApplicationSubmitted = applicationSubmitted;
globalThis.naukriProfileIncomplete = profileIncompleteBlock;
