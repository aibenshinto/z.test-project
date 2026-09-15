// LinkedIn observer — thin adapter over the shared core.
//
// Element discovery, metadata and the logical-target registry are shared with
// every other adapter. What stays here is genuinely LinkedIn-specific: which
// subtree is the Easy Apply dialog, how LinkedIn labels its form sections, and
// how it signals completion.
//
// LinkedIn selectors are HINTS (Part 18). If the artdeco class names change,
// the shared core still sees the buttons and fields, because it identifies
// controls by semantics rather than by class.

/* global LINKEDIN_SEL, linkedinCheckAnomaly */

(function () {
  if (globalThis.linkedinObserver) return; // idempotent guard

  const core = () => globalThis.__autoApplyObserverCore;
  const logic = () => globalThis.__autoApplyInteractionCore;

  // -------------------------------------------------------------------------
  // Easy Apply dialog
  // -------------------------------------------------------------------------

  function dialogRoot() {
    return [...document.querySelectorAll(LINKEDIN_SEL.form.dialog)]
      .filter(core().isVisible).at(-1) || null;
  }

  /** LinkedIn's own completion indicator — authoritative for submission. */
  function isComplete() {
    const els = [...document.querySelectorAll(LINKEDIN_SEL.form.completion)]
      .filter(core().isVisible);
    if (els.some((el) => /application (?:was )?(?:submitted|sent)|application complete/i
      .test(core().innerText(el)))) {
      return true;
    }
    // LinkedIn also renders a post-submit confirmation outside that selector.
    return logic().hasSubmissionEvidence(core().visibleBodyText(2000));
  }

  // -------------------------------------------------------------------------
  // Application state
  // -------------------------------------------------------------------------

  function detectApplicationState() {
    if (linkedinCheckAnomaly()) return "blocked";
    if (isComplete()) return "done";
    if (dialogRoot()) return "applying";
    if (LINKEDIN_SEL.job.externalApply()) return "external";
    if (LINKEDIN_SEL.job.easyApply()) return "ready";

    // The selector hint may be stale after a LinkedIn redesign; fall back to
    // semantic apply-intent detection before giving up.
    const elements = core().collectElements(document.body, 120);
    if (logic().findApplyCandidates(elements).some((c) => c.score >= 0.9)) return "ready";

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
      "legend", "[data-test-form-element-label]",
      ".fb-dash-form-element__label", "[class*='form-element__label']",
      ".jobs-easy-apply-form-section__title", "h3", "h4",
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
      ".artdeco-inline-feedback--error, [class*='error-message'], " +
      "[aria-live='assertive'], [data-test-form-element-error-message]",
    )].filter(core().isVisible).map(core().innerText).filter(Boolean);
  }

  function detectLoading(root) {
    return Boolean(
      root.querySelector(
        ".artdeco-loader, [class*='loader'], [class*='spinner'], " +
        "[aria-label*='loading' i], [data-test-loader]",
      ) || document.querySelector(".artdeco-loader--active"),
    );
  }

  // -------------------------------------------------------------------------
  // observe()
  // -------------------------------------------------------------------------

  function observe() {
    const state = detectApplicationState();
    // Inside the dialog, show only the dialog. On the job page, show the page.
    const root = dialogRoot() || document.body;

    return core().buildSnapshot({
      root,
      platform: "linkedin",
      applicationState: state,
      questions: extractQuestions(root),
      errors: extractErrors(root),
      successIndicators: [...document.querySelectorAll(LINKEDIN_SEL.form.completion)]
        .filter(core().isVisible).map(core().innerText).filter(Boolean),
      loading: detectLoading(root),
    });
  }

  globalThis.linkedinObserver = {
    observe,
    isComplete,
    dialogRoot,
    detectApplicationState,
    getElement: (id) => core().resolveLive(id).el || null,
    clearRegistry: () => core().resetRegistry(),
  };
}());
