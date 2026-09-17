// Generic (external ATS) observer — thin adapter over the shared core.
//
// Works on Greenhouse, Lever, Workday, SmartRecruiters, iCIMS, Jobvite and any
// other site whose controls are standard HTML. There is nothing ATS-specific
// about how elements are found: the shared core captures every visible
// interactive control, and this file only supplies the page-level context
// (which subtree to prefer, what state the application is in).
//
// Previously this file carried its own copy of the element walker, which
// filtered buttons through a hardcoded job-application word list and so hid
// controls such as "Start application" from the model. That filtering is gone.

(function () {
  if (globalThis.genericObserver) return; // idempotent guard

  const core = () => globalThis.__autoApplyObserverCore;
  const logic = () => globalThis.__autoApplyInteractionCore;

  // -------------------------------------------------------------------------
  // Application root
  // -------------------------------------------------------------------------

  // A form is the application only when something about it says so: a control
  // to attach a CV, or wording that names an application. A careers page
  // carries other forms — contact, enquiry, newsletter, search — and one of
  // those asks for a name and an email just as an application does. Taking a
  // contact form for the application is worse than finding nothing: the agent
  // sits filling it in, and sends the company a message instead of applying.
  const APPLICATION_WORDING = /application|apply|candidate|resume|cv|cover letter/i;

  function looksLikeApplication(form) {
    if (form.querySelector("input[type='file']")) return true;
    return APPLICATION_WORDING.test(core().innerText(form).slice(0, 1500));
  }

  /**
   * Prefer the subtree that holds the application form, so the model is not
   * shown an entire marketing page. Returns null when this page has no
   * application on it, which the caller reports rather than guessing.
   */
  function findApplicationRoot() {
    const isVisible = core().isVisible;

    const dialog = [...document.querySelectorAll(
      "[role='dialog'], [aria-modal='true'], dialog[open], .modal, .overlay, " +
      "[class*='modal'], [class*='drawer']",
    )]
      .filter(isVisible)
      .sort((a, b) => b.querySelectorAll("input,textarea,select").length -
                      a.querySelectorAll("input,textarea,select").length)[0];
    if (dialog && dialog.querySelectorAll("input,textarea,select").length > 0) return dialog;

    const forms = [...document.querySelectorAll("form")]
      .filter(isVisible)
      .sort((a, b) => b.querySelectorAll("input,textarea,select").length -
                      a.querySelectorAll("input,textarea,select").length);

    return forms.find(looksLikeApplication) || null;
  }

  // -------------------------------------------------------------------------
  // Application state
  // -------------------------------------------------------------------------

  function detectApplicationState() {
    // Security first — never proceed past a challenge.
    const security = logic().detectSecurityChallenge(core().securitySignals());
    if (security.blocked) return security.kind === "login" ? "login" : "blocked";

    const bodyText = core().visibleBodyText(3000);
    if (logic().hasSubmissionEvidence(bodyText)) return "done";

    if (findApplicationRoot()) return "applying";

    // A page that offers a way in, but has not been started yet.
    const elements = core().collectElements(document.body, 120);
    if (logic().findApplyCandidates(elements).length) return "ready";

    return "unknown";
  }

  // -------------------------------------------------------------------------
  // Questions / errors / loading
  // -------------------------------------------------------------------------

  function extractQuestions(root) {
    const questions = [];
    const seen = new Set();
    let idx = 1;

    const selectors = [
      "legend", "fieldset > label:first-child",
      "[class*='question']", "[class*='label']:not(label)",
      "h1", "h2", "h3", "h4",
    ];

    for (const sel of selectors) {
      for (const el of root.querySelectorAll(sel)) {
        if (!core().isVisible(el)) continue;
        const text = core().innerText(el);
        if (!text || text.length < 4 || seen.has(text)) continue;
        seen.add(text);
        questions.push({ id: "question_" + idx++, text });
      }
    }
    return questions;
  }

  function extractErrors(root) {
    return [...root.querySelectorAll(
      "[class*='error']:not([class*='error-page']), [role='alert'], [aria-live='assertive'], " +
      "[class*='invalid'], [class*='validation-message']",
    )].filter(core().isVisible).map(core().innerText).filter(Boolean);
  }

  function extractSuccessIndicators() {
    const bodyText = core().visibleBodyText(2000);
    return logic().hasSubmissionEvidence(bodyText) ? ["Application submitted"] : [];
  }

  function detectLoading(root) {
    return Boolean(
      root.querySelector("[class*='loader'], [class*='spinner'], [class*='loading'], [aria-busy='true']") ||
      document.querySelector("[class*='loader-overlay'], .loading-overlay"),
    );
  }

  // -------------------------------------------------------------------------
  // observe()
  // -------------------------------------------------------------------------

  function observe() {
    const state = detectApplicationState();
    const root = findApplicationRoot() || document.body;

    return core().buildSnapshot({
      root,
      platform: "generic",
      applicationState: state,
      questions: extractQuestions(root),
      errors: extractErrors(root),
      successIndicators: extractSuccessIndicators(),
      loading: detectLoading(root),
    });
  }

  function isComplete() {
    return logic().hasSubmissionEvidence(core().visibleBodyText(3000));
  }

  globalThis.genericObserver = {
    observe,
    isComplete,
    findApplicationRoot,
    detectApplicationState,
    // Retained for callers that still resolve IDs through the observer.
    getElement: (id) => core().resolveLive(id).el || null,
    clearRegistry: () => core().resetRegistry(),
  };
}());
