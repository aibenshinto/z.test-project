// LinkedIn UI Observer.
//
// Responsibility: inspect the current visible LinkedIn Easy Apply dialog (or
// job page) and produce a compact, structured UISnapshot that the AI Decision
// Engine can understand without receiving raw HTML.
//
// Every interactive element in the snapshot gets a temporary ID (element_N).
// The ID is stored in `elementRegistry` so the LinkedIn Action Executor can
// resolve it back to the real DOM node when the AI returns an action.
//
// IDs are invalidated on each fresh observe() call. Never cache them across
// observe() invocations.
//
// UISnapshot shape (identical to Naukri's so the shared AI prompt works):
//   {
//     page: { url, title, applicationState },
//     questions: [{ id, text }],
//     controls: [{ id, type, text, ... }],
//     messages: [],
//     errors: [],
//     successIndicators: [],
//     loading: bool,
//   }

/* global LINKEDIN_SEL, linkedinCheckAnomaly, linkedinVisible */


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
// Visibility helper (re-uses the globalThis.linkedinVisible defined in selectors.js)
// ---------------------------------------------------------------------------

function isVisible(el) {
  if (!el) return false;
  try { return linkedinVisible(el); } catch (_) {
    // Fallback if selectors.js not yet loaded
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }
}

// ---------------------------------------------------------------------------
// Application-state detection
// ---------------------------------------------------------------------------

function detectApplicationState() {
  const anomaly = linkedinCheckAnomaly();
  if (anomaly) return "anomaly";

  // Completion
  const completionEls = document.querySelectorAll(LINKEDIN_SEL.form.completion);
  if ([...completionEls].some((el) =>
    isVisible(el) && /application (?:was )?(?:submitted|sent)|application complete/i.test(
      String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()
    )
  )) return "done";

  // Easy Apply dialog is open
  const dialogs = [...document.querySelectorAll(LINKEDIN_SEL.form.dialog)].filter(isVisible);
  if (dialogs.length) return "applying";

  // External apply link visible
  if (LINKEDIN_SEL.job.externalApply()) return "external";

  // Easy Apply button present (not yet clicked)
  if (LINKEDIN_SEL.job.easyApply()) return "ready";

  return "unknown";
}

// ---------------------------------------------------------------------------
// Helpers: text extraction
// ---------------------------------------------------------------------------

function innerText(el) {
  return String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Question (label/legend) extraction from the dialog
// ---------------------------------------------------------------------------

function extractQuestions(root) {
  const questions = [];
  const seen = new Set();
  let qIdx = 1;

  // Legends (radio groups / fieldset questions)
  for (const el of root.querySelectorAll("legend, [data-test-form-element-label]")) {
    if (!isVisible(el)) continue;
    const text = innerText(el);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    questions.push({ id: "question_" + qIdx++, text });
  }

  // Artdeco form labels / section headings
  for (const el of root.querySelectorAll(
    ".fb-dash-form-element__label, [class*='form-element__label'], " +
    ".jobs-easy-apply-form-section__title, h3, h4"
  )) {
    if (!isVisible(el)) continue;
    const text = innerText(el);
    if (!text || seen.has(text) || text.length < 4) continue;
    seen.add(text);
    questions.push({ id: "question_" + qIdx++, text });
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Element descriptor
// ---------------------------------------------------------------------------

function labelFor(control, root) {
  // Explicit for= association
  if (control.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
    if (lbl) return innerText(lbl);
  }
  // aria-label / placeholder
  const aria = control.getAttribute("aria-label") || control.getAttribute("placeholder");
  if (aria) return aria.trim();
  // Nearest container label/legend
  const container = control.closest(
    "fieldset, [data-test-form-element], .fb-dash-form-element, " +
    ".jobs-easy-apply-form-section__grouping, .artdeco-text-input--container"
  ) || root;
  const labelEl = container.querySelector("legend, label, [id$='-label'], [class*='label']");
  return labelEl ? innerText(labelEl) : "";
}

function describeElement(el, root) {
  const tag = el.tagName.toLowerCase();

  if (tag === "input") {
    const type = (el.type || "text").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "password"].includes(type)) return null;

    if (type === "radio") {
      return {
        type: "radio",
        text: labelFor(el, root),
        name: el.name || "",
        value: el.value || "",
        checked: Boolean(el.checked),
        visible: true,
      };
    }
    if (type === "checkbox") {
      return {
        type: "checkbox",
        text: labelFor(el, root),
        checked: Boolean(el.checked),
        visible: true,
      };
    }
    if (type === "file") {
      return { type: "file", text: labelFor(el, root), visible: true };
    }
    // text / email / number / tel / url / date
    return {
      type: "text",
      text: labelFor(el, root),
      value: el.value || "",
      placeholder: el.placeholder || "",
      visible: true,
    };
  }

  if (tag === "textarea") {
    return {
      type: "textarea",
      text: labelFor(el, root),
      value: el.value || "",
      placeholder: el.placeholder || "",
      visible: true,
    };
  }

  if (tag === "select") {
    const selected = el.options[el.selectedIndex];
    return {
      type: "select",
      text: labelFor(el, root),
      value: el.value || "",
      selectedText: selected ? innerText(selected) : "",
      options: [...el.options].map((o) => innerText(o)).filter(Boolean),
      visible: true,
    };
  }

  if (tag === "button" || el.getAttribute("role") === "button") {
    const text = innerText(el);
    if (!text) return null;
    // Only wizard navigation + submission buttons
    if (!/next|continue|review|submit|apply|upload|done|save/i.test(text)) return null;
    return {
      type: "button",
      text,
      disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
      visible: true,
    };
  }

  // LinkedIn custom typeahead / artdeco dropdown trigger
  if (el.getAttribute("role") === "combobox" || el.getAttribute("role") === "listbox") {
    return {
      type: "combobox",
      text: labelFor(el, root),
      value: innerText(el),
      visible: true,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Interactive element extraction
// ---------------------------------------------------------------------------

function extractControls(root) {
  const controls = [];
  const seenRadioNames = new Set();
  const seen = new Set();

  const candidates = [
    ...root.querySelectorAll(
      "input, textarea, select, button, [role='button'], " +
      "[role='combobox'], [role='listbox']"
    ),
  ];

  for (const el of candidates) {
    if (seen.has(el)) continue;
    if (!isVisible(el)) continue;
    if (el.disabled || el.readOnly) continue;

    // Deduplicate radio groups — one entry per name
    if (el.tagName === "INPUT" && el.type === "radio") {
      if (!el.name || seenRadioNames.has(el.name)) continue;
      seenRadioNames.add(el.name);
      // Collect all radios in this group and expose them as one entry
      const groupEls = [...root.querySelectorAll(
        `input[type='radio'][name="${CSS.escape(el.name)}"]`
      )].filter(isVisible);
      if (!groupEls.length) continue;
      const options = groupEls.map((radio) => {
        const lbl = radio.id
          ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)
          : radio.closest("label");
        return {
          id: register(radio),
          label: lbl ? innerText(lbl) : (radio.value || ""),
          checked: radio.checked,
        };
      });
      seen.add(el);
      groupEls.forEach((r) => seen.add(r));
      controls.push({
        id: options[0].id,            // id of the first radio in the group
        type: "radiogroup",
        text: labelFor(el, root),
        name: el.name,
        options,                      // [{id, label, checked}] — AI picks one id
        visible: true,
      });
      continue;
    }

    const desc = describeElement(el, root);
    if (!desc) continue;
    seen.add(el);
    const id = register(el);
    controls.push({ id, ...desc });
  }

  return controls;
}

// ---------------------------------------------------------------------------
// Error / success / loading extractors
// ---------------------------------------------------------------------------

function extractErrors(root) {
  return [...root.querySelectorAll(
    ".artdeco-inline-feedback--error, [class*='error-message'], " +
    "[aria-live='assertive'], [data-test-form-element-error-message]"
  )]
    .filter(isVisible)
    .map((el) => innerText(el))
    .filter(Boolean);
}

function extractSuccessIndicators(root) {
  return [...root.querySelectorAll(LINKEDIN_SEL.form.completion)]
    .filter(isVisible)
    .map((el) => innerText(el))
    .filter(Boolean);
}

function detectLoading(root) {
  return Boolean(
    root.querySelector(
      ".artdeco-loader, [class*='loader'], [class*='spinner'], " +
      "[aria-label*='loading' i], [data-test-loader]"
    ) ||
    document.querySelector(".artdeco-loader--active")
  );
}

// ---------------------------------------------------------------------------
// Main observe() function
// ---------------------------------------------------------------------------

/**
 * Inspect the current visible LinkedIn Easy Apply UI and produce a UISnapshot.
 *
 * Resets the element registry on each call — IDs from previous calls are
 * invalid after this returns.
 *
 * @returns {object} UISnapshot
 */
function observe() {
  resetRegistry();

  const state = detectApplicationState();

  // Prefer the visible Easy Apply dialog; fall back to document.body
  const dialogEls = [...document.querySelectorAll(LINKEDIN_SEL.form.dialog)].filter(isVisible);
  const root = dialogEls.at(-1) || document.body;

  const questions        = extractQuestions(root);
  const controls         = extractControls(root);
  const errors           = extractErrors(root);
  const successIndicators = extractSuccessIndicators(root);
  const loading          = detectLoading(root);

  return {
    page: {
      url: location.href,
      title: document.title,
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
  if (!document.contains(el)) return null;
  return el;
}

function clearRegistry() {
  resetRegistry();
}

globalThis.linkedinObserver = { observe, getElement, clearRegistry };
