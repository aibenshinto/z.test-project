// Naukri observer — thin adapter over the shared core.
//
// Element discovery, metadata and the logical-target registry are shared with
// every other adapter. What stays here is Naukri-specific: the distinction
// between the chatbot drawer and the radio questionnaire panel, which subtree
// to scope observation to, and Naukri's own applied/submitted markers.
//
// Two behaviours the old copy had that mattered and are preserved:
//   - `.textArea` is contenteditable; the shared executor handles that case.
//   - `#apply-button` is not unique; only visible nodes are ever considered.
//
// The old copy also filtered buttons to an exact-match list
// (save|send|next|submit|apply|continue|proceed|done|ok), which hid every
// other control from the model. That filter is gone: the shared core reports
// all visible interactive controls and ranks apply-intent as a hint.

/* global NAUKRI_SEL, naukriApplicationSubmitted */

(function () {
  if (globalThis.naukriObserver) return; // idempotent guard

  const core = () => globalThis.__autoApplyObserverCore;
  const logic = () => globalThis.__autoApplyInteractionCore;

  // -------------------------------------------------------------------------
  // Naukri UI modes
  // -------------------------------------------------------------------------

  const QUESTIONNAIRE_SELECTORS = [
    ".singleselect-radiobutton",
    ".ssrc__radio-btn-container",
    "[class*='questionnaire']",
    "[class*='Questionnaire']",
  ];

  function questionnairePanel() {
    for (const sel of QUESTIONNAIRE_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function chatbotDrawer() {
    return document.querySelector(NAUKRI_SEL.questionnaire.drawer);
  }

  /** Naukri's authoritative submission check, preserved from the original. */
  function isComplete() {
    try {
      if (naukriApplicationSubmitted()) return true;
    } catch (_) { /* selectors may not be loaded yet */ }
    if (document.querySelector("[class*='already-applied'], [class*='appliedTag']")) return true;
    // Naukri also renders a plain confirmation banner in some flows, which the
    // marker selectors above miss. The shared evidence test is disqualified by
    // sidebar rails and step counters, so this cannot fire on a results page.
    return logic().hasSubmissionEvidence(core().visibleBodyText(3000));
  }

  // -------------------------------------------------------------------------
  // Application state
  // -------------------------------------------------------------------------

  function detectApplicationState() {
    if (isComplete()) return "done";
    if (chatbotDrawer()) return "chatbot";
    if (questionnairePanel()) return "questionnaire";

    // The Apply button in its pre-click state. Must be a VISIBLE node:
    // `#apply-button` is not unique on a Naukri job page.
    const applyBtn = [...document.querySelectorAll(NAUKRI_SEL.job.applyButton)]
      .find((el) => core().isVisible(el));
    if (applyBtn) return "ready";

    return "unknown";
  }

  // -------------------------------------------------------------------------
  // Questions
  // -------------------------------------------------------------------------

  function extractQuestions(root) {
    const questions = [];
    const seen = new Set();
    let idx = 1;

    const selectors = [
      ".botMsg", ".chatbot_MessageContainer .botMsg",
      "[class*='question']", "[class*='Question']",
      "legend", "label", "h3", "h4",
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
      ".error-message, [class*='error'], [class*='alert-danger'], [aria-live='assertive']",
    )].filter(core().isVisible).map(core().innerText).filter(Boolean);
  }

  function extractSuccessIndicators(root) {
    return [...root.querySelectorAll(
      "[class*='success'], [class*='applied'], [class*='thank'], [aria-live='polite']",
    )].filter(core().isVisible).map(core().innerText).filter(Boolean);
  }

  function detectLoading(root) {
    return Boolean(
      root.querySelector("[class*='loader'], [class*='spinner'], [class*='loading']"),
    );
  }

  // -------------------------------------------------------------------------
  // observe()
  // -------------------------------------------------------------------------

  function observe() {
    const state = detectApplicationState();

    const root = questionnairePanel() ||
      chatbotDrawer() ||
      document.querySelector(NAUKRI_SEL.questionnaire.container) ||
      document.body;

    const snapshot = core().buildSnapshot({
      root,
      platform: "naukri",
      applicationState: state,
      questions: extractQuestions(root),
      errors: extractErrors(root),
      successIndicators: extractSuccessIndicators(root),
      loading: detectLoading(root),
    });

    // Prefer the job header as the page title, as the original did.
    const header = document.querySelector(NAUKRI_SEL.job.headerTitle);
    if (header) snapshot.page.title = core().innerText(header) || snapshot.page.title;

    return snapshot;
  }

  globalThis.naukriObserver = {
    observe,
    isComplete,
    detectApplicationState,
    questionnairePanel,
    chatbotDrawer,
    getElement: (id) => core().resolveLive(id).el || null,
    clearRegistry: () => core().resetRegistry(),
  };
}());
