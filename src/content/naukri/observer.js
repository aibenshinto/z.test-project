// Naukri UI Observer.
//
// Responsibility: inspect the CURRENT visible application UI and produce a
// compact, structured UISnapshot that the AI Decision Engine can understand
// without receiving raw HTML.
//
// Every interactive element in the snapshot gets a temporary ID (element_N).
// The ID is stored in `elementRegistry` so the Browser Action Executor can
// resolve it back to the real DOM node when the AI returns an action.
//
// IDs are invalidated on each fresh observe() call. Never cache them across
// observe() invocations.

/* global NAUKRI_SEL */


/** @type {Map<string, Element>} */
const elementRegistry = new Map();
let _nextId = 1;

function resetRegistry() {
  elementRegistry.clear();
  _nextId = 1;
}

function register(el) {
  const id = "element_" + _nextId++;
  elementRegistry.set(id, el);
  return id;
}

// ---------------------------------------------------------------------------
// Visibility helpers
// ---------------------------------------------------------------------------

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Application-state detection
// ---------------------------------------------------------------------------

function detectApplicationState() {
  // Chatbot drawer (existing free-text path)
  if (document.querySelector(NAUKRI_SEL.questionnaire.drawer)) {
    return "chatbot";
  }
  // Radio/form questionnaire panels — Naukri's multi-choice notice-period style
  if (
    document.querySelector(".singleselect-radiobutton") ||
    document.querySelector(".ssrc__radio-btn-container") ||
    document.querySelector("[class*='questionnaire']") ||
    document.querySelector("[class*='Questionnaire']")
  ) {
    return "questionnaire";
  }
  // Apply button in its pre-click state → page is ready to start
  const applyBtn = [...document.querySelectorAll(NAUKRI_SEL.job.applyButton)].find(
    (el) => isVisible(el) && /^apply$/i.test((el.innerText || "").trim()),
  );
  if (applyBtn) return "applying";
  // Already applied
  if (document.querySelector("[class*='already-applied'], [class*='appliedTag']")) {
    return "done";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Element extractors
// ---------------------------------------------------------------------------

/**
 * Extract a compact descriptor for one interactive element.
 * Returns null if the element should not be included in the snapshot.
 */
function describeElement(el) {
  const tag = el.tagName.toLowerCase();

  if (tag === "input") {
    const type = (el.type || "text").toLowerCase();
    if (type === "radio") {
      return {
        type: "radio",
        text: (el.labels && el.labels[0] ? el.labels[0].innerText.trim() :
               el.closest("label")?.innerText.trim() ||
               el.getAttribute("aria-label") || ""),
        name: el.name || "",
        value: el.value || "",
        checked: Boolean(el.checked),
        visible: isVisible(el),
      };
    }
    if (type === "checkbox") {
      return {
        type: "checkbox",
        text: (el.labels && el.labels[0] ? el.labels[0].innerText.trim() :
               el.closest("label")?.innerText.trim() ||
               el.getAttribute("aria-label") || ""),
        checked: Boolean(el.checked),
        visible: isVisible(el),
      };
    }
    if (type === "file") {
      return { type: "file", visible: isVisible(el), text: "" };
    }
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) return null;
    return {
      type: "text",
      placeholder: el.placeholder || "",
      value: el.value || "",
      visible: isVisible(el),
      text: el.getAttribute("aria-label") || el.placeholder || "",
    };
  }

  if (tag === "textarea") {
    return {
      type: "textarea",
      value: el.value || "",
      placeholder: el.placeholder || "",
      visible: isVisible(el),
      text: el.getAttribute("aria-label") || el.placeholder || "",
    };
  }

  if (el.isContentEditable) {
    return {
      type: "contenteditable",
      value: el.textContent.trim(),
      visible: isVisible(el),
      text: el.getAttribute("aria-label") || el.getAttribute("placeholder") || "",
    };
  }

  if (tag === "select") {
    const selected = el.options[el.selectedIndex];
    return {
      type: "select",
      value: el.value || "",
      selectedText: selected ? selected.text.trim() : "",
      options: [...el.options].map((o) => o.text.trim()).filter(Boolean),
      visible: isVisible(el),
      text: el.getAttribute("aria-label") || "",
    };
  }

  if (tag === "button" || el.getAttribute("role") === "button") {
    const text = (el.innerText || "").trim();
    if (!text) return null;
    // Only include controls relevant to the application flow
    return {
      type: "button",
      text,
      disabled: Boolean(el.disabled),
      visible: isVisible(el),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Questionnaire panel scrapers
// ---------------------------------------------------------------------------

/** Extract radio options from Naukri's .singleselect-radiobutton / .ssrc__radio style. */
function extractRadioOptions(root) {
  const controls = [];
  const containers = root.querySelectorAll(
    ".ssrc__radio-btn-container, .singleselect-radiobutton label, [class*='radio-btn']",
  );

  for (const container of containers) {
    const input = container.querySelector("input[type='radio']") ||
                  (container.tagName.toLowerCase() === "input" ? container : null);
    const label = container.querySelector("label, .ssrc__label, [class*='label']") ||
                  container.closest("label") || container;
    if (!isVisible(container)) continue;
    const text = (input?.labels?.[0]?.innerText || label?.innerText || "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    const id = register(input || container);
    controls.push({
      id,
      type: "radio",
      text,
      checked: Boolean(input?.checked),
      visible: true,
    });
  }
  return controls;
}

/** Extract generic interactive elements from a root element. */
function extractInteractiveElements(root) {
  const controls = [];
  const seen = new Set();

  const candidates = [
    ...root.querySelectorAll(
      "input, textarea, select, button, [role='button'], [contenteditable='true']",
    ),
  ];

  for (const el of candidates) {
    if (seen.has(el)) continue;
    if (!isVisible(el)) continue;

    const desc = describeElement(el);
    if (!desc) continue;

    // De-duplicate radios: if we already captured via extractRadioOptions, skip
    if (desc.type === "radio") {
      seen.add(el);
      continue;   // radios handled by extractRadioOptions
    }

    seen.add(el);
    const id = register(el);
    controls.push({ id, ...desc });
  }
  return controls;
}

// ---------------------------------------------------------------------------
// Question extraction
// ---------------------------------------------------------------------------

/** Extract visible question text from a questionnaire root. */
function extractQuestions(root) {
  const questions = [];
  const questionSelectors = [
    // Naukri questionnaire-specific
    ".ssrc__question-text",
    "[class*='question-text']",
    "[class*='questionText']",
    "[class*='QuestionText']",
    // Chatbot
    "li.botItem .botMsg",
    // Generic legend/label
    "legend",
    "fieldset > .question",
  ];

  const questionEls = [];
  for (const sel of questionSelectors) {
    questionEls.push(...root.querySelectorAll(sel));
  }

  const seen = new Set();
  let qIdx = 1;
  for (const el of questionEls) {
    if (!isVisible(el)) continue;
    const text = el.innerText.trim().replace(/\s+/g, " ");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    questions.push({ id: "question_" + qIdx++, text });
  }
  return questions;
}

// ---------------------------------------------------------------------------
// Buttons (Save / Next / Submit / Apply)
// ---------------------------------------------------------------------------

function extractActionButtons(root) {
  const buttons = [];
  const targets = [
    ...root.querySelectorAll("button, div[class*='btn'], div[class*='Btn'], a[class*='btn']"),
  ];
  for (const el of targets) {
    if (!isVisible(el)) continue;
    const text = (el.innerText || "").trim();
    if (!text) continue;
    // Only action-relevant labels
    if (!/^(save|send|next|submit|apply|continue|proceed|done|ok)$/i.test(text)) continue;
    const id = register(el);
    buttons.push({ id, type: "button", text, visible: true });
  }
  return buttons;
}

// ---------------------------------------------------------------------------
// Messages / errors / success
// ---------------------------------------------------------------------------

function extractMessages(root) {
  return [...root.querySelectorAll(
    ".error-message, [class*='error'], [class*='alert-danger'], [aria-live='assertive']",
  )]
    .filter(isVisible)
    .map((el) => el.innerText.trim())
    .filter(Boolean);
}

function extractSuccessIndicators(root) {
  return [...root.querySelectorAll(
    "[class*='success'], [class*='applied'], [class*='thank'], [aria-live='polite']",
  )]
    .filter(isVisible)
    .map((el) => el.innerText.trim())
    .filter(Boolean);
}

function detectLoading(root) {
  return Boolean(
    root.querySelector("[class*='loader'], [class*='spinner'], [class*='loading']") ||
    document.querySelector("[class*='loader'], [class*='spinner']"),
  );
}

// ---------------------------------------------------------------------------
// Main observe() function
// ---------------------------------------------------------------------------

/**
 * Inspect the current visible Naukri application UI and produce a UISnapshot.
 *
 * Resets the element registry on each call — IDs from previous calls are
 * invalid after this returns.
 *
 * @returns {object} UISnapshot
 */
function observe() {
  resetRegistry();

  const state = detectApplicationState();

  // Determine the root scope to walk. Prefer the questionnaire panel if
  // visible; fall back to the whole document body.
  const questionnaireRoot =
    document.querySelector(".singleselect-radiobutton") ||
    document.querySelector("[class*='questionnaire']") ||
    document.querySelector("[class*='Questionnaire']") ||
    document.querySelector(NAUKRI_SEL.questionnaire.drawer) ||
    document.querySelector(NAUKRI_SEL.questionnaire.container) ||
    document.body;

  // Extract questions
  const questions = extractQuestions(questionnaireRoot);

  // Extract controls: radio options first (Naukri-specific), then generic inputs
  const radioControls = extractRadioOptions(questionnaireRoot);
  const genericControls = extractInteractiveElements(questionnaireRoot);
  const actionButtons = extractActionButtons(questionnaireRoot);

  // Merge and de-duplicate by element_id
  const seenIds = new Set();
  const controls = [];
  for (const c of [...radioControls, ...genericControls, ...actionButtons]) {
    if (!seenIds.has(c.id)) {
      seenIds.add(c.id);
      controls.push(c);
    }
  }

  const errors = extractMessages(questionnaireRoot);
  const successIndicators = extractSuccessIndicators(questionnaireRoot);
  const loading = detectLoading(questionnaireRoot);

  return {
    page: {
      url: location.href,
      title: (() => {
        const h = document.querySelector(NAUKRI_SEL.job.headerTitle);
        return h ? h.innerText.trim() : document.title;
      })(),
      applicationState: state,
    },
    questions,
    controls,
    messages: [],
    errors,
    successIndicators,
    loading,
  };
}

/**
 * Resolve a temporary element ID back to its live DOM node.
 * Returns null if the ID is unknown or the node has been detached.
 */
function getElement(id) {
  const el = elementRegistry.get(id);
  if (!el) return null;
  // Verify still in the document
  if (!document.contains(el)) return null;
  return el;
}

function clearRegistry() {
  resetRegistry();
}

globalThis.naukriObserver = { observe, getElement, clearRegistry };
