// Generic (External ATS) UI Observer.
//
// Responsibility: inspect the current visible page on any company career site
// and produce a compact UISnapshot that the AI Decision Engine can understand
// without receiving raw HTML.
//
// Works on Greenhouse, Lever, Workday, SmartRecruiters, iCIMS, Jobvite, and
// any other ATS whose controls are standard HTML inputs / selects / radios.
//
// UISnapshot shape (identical to Naukri + LinkedIn so the shared AI prompt works):
//   { page, questions, controls, messages, errors, successIndicators, loading }
//
// element_N IDs are reset on each observe() call — never cache across calls.

(function () {
  if (globalThis.genericObserver) return; // idempotent guard

  /** @type {Map<string, Element>} */
  const elementRegistry = new Map();
  let _nextId = 1;

  function resetRegistry() { elementRegistry.clear(); _nextId = 1; }
  function register(el) {
    const id = "element_" + _nextId++;
    elementRegistry.set(id, el);
    return id;
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  function innerText(el) {
    return String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  // ---------------------------------------------------------------------------
  // Application state detection
  // ---------------------------------------------------------------------------

  function detectApplicationState() {
    const bodyText = innerText(document.body).slice(0, 3000).toLowerCase();

    // CAPTCHA / challenge
    const hasCaptcha = [
      "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']",
      "iframe[src*='turnstile']", "[id*='captcha']", "[class*='captcha']",
    ].some((sel) => [...document.querySelectorAll(sel)].some(isVisible));
    if (hasCaptcha || /verify you are human|security check|access denied/.test(bodyText)) {
      return "blocked";
    }

    // Login wall
    if (isVisible(document.querySelector("input[type='password']")) &&
        /sign in|log in|login/.test(bodyText.slice(0, 800))) {
      return "login";
    }

    // Completion
    if (/application (?:was )?(?:submitted|received|complete)|thank you for applying|we.ve received your application/i.test(bodyText)) {
      return "done";
    }

    // Has an application form
    const root = findApplicationRoot();
    if (root) return "applying";

    return "unknown";
  }

  // ---------------------------------------------------------------------------
  // Find the best application form root on the page
  // ---------------------------------------------------------------------------

  function findApplicationRoot() {
    // Prefer dialog / modal
    const dialog = [...document.querySelectorAll("[role='dialog'], .modal, .overlay, [class*='modal'], [class*='drawer']")]
      .filter(isVisible)
      .sort((a, b) => b.querySelectorAll("input,textarea,select").length -
                      a.querySelectorAll("input,textarea,select").length)[0];
    if (dialog && dialog.querySelectorAll("input,textarea,select").length > 0) return dialog;

    // Prefer forms that contain application-related text
    const forms = [...document.querySelectorAll("form")]
      .filter((f) => isVisible(f))
      .sort((a, b) => b.querySelectorAll("input,textarea,select").length -
                      a.querySelectorAll("input,textarea,select").length);

    // First form with application-like heading
    const appForm = forms.find((f) =>
      /application|apply|candidate|resume|cv/i.test(innerText(f).slice(0, 1500))
    );
    if (appForm) return appForm;

    // Any visible form with at least 2 controls
    return forms.find((f) => f.querySelectorAll("input,textarea,select").length >= 2) || null;
  }

  // ---------------------------------------------------------------------------
  // Question (label / legend) extraction
  // ---------------------------------------------------------------------------

  function extractQuestions(root) {
    const questions = [];
    const seen = new Set();
    let qIdx = 1;

    const selectors = [
      "legend", "fieldset > label:first-child",
      "[class*='question']", "[class*='label']:not(label)",
      "h1", "h2", "h3", "h4",
    ];

    for (const sel of selectors) {
      for (const el of root.querySelectorAll(sel)) {
        if (!isVisible(el)) continue;
        const text = innerText(el);
        if (!text || text.length < 4 || seen.has(text)) continue;
        seen.add(text);
        questions.push({ id: "question_" + qIdx++, text });
      }
    }
    return questions;
  }

  // ---------------------------------------------------------------------------
  // Label resolution for a control
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

    // Walk up to containing group
    const group = control.closest(
      "fieldset, [role='group'], .form-group, .field, " +
      "[class*='field'], [class*='question'], [class*='form-row'], label"
    ) || root;

    const labelEl = group.querySelector("legend, label, [id$='-label'], [class*='label']");
    if (labelEl && labelEl !== control) return innerText(labelEl);

    // Control's own name attribute as last resort
    return control.name || "";
  }

  // ---------------------------------------------------------------------------
  // Element descriptor
  // ---------------------------------------------------------------------------

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
        return { type: "checkbox", text: labelFor(el, root), checked: Boolean(el.checked), visible: true };
      }
      if (type === "file") {
        return { type: "file", text: labelFor(el, root), visible: true };
      }
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
      if (!/next|continue|review|submit|apply|save|upload|done/i.test(text)) return null;
      return {
        type: "button",
        text,
        disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
        visible: true,
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Control extraction
  // ---------------------------------------------------------------------------

  function extractControls(root) {
    const controls = [];
    const seenRadioNames = new Set();
    const seen = new Set();

    const candidates = [...root.querySelectorAll(
      "input, textarea, select, button, [role='button']"
    )];

    for (const el of candidates) {
      if (seen.has(el)) continue;
      if (!isVisible(el)) continue;
      if (el.disabled || el.readOnly) continue;

      // Radio group de-duplication
      if (el.tagName === "INPUT" && el.type === "radio") {
        if (!el.name || seenRadioNames.has(el.name)) continue;
        seenRadioNames.add(el.name);

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

        groupEls.forEach((r) => seen.add(r));
        controls.push({
          id: options[0].id,
          type: "radiogroup",
          text: labelFor(el, root),
          name: el.name,
          options,
          visible: true,
        });
        continue;
      }

      const desc = describeElement(el, root);
      if (!desc) continue;
      seen.add(el);
      controls.push({ id: register(el), ...desc });
    }

    return controls;
  }

  // ---------------------------------------------------------------------------
  // Errors / success / loading
  // ---------------------------------------------------------------------------

  function extractErrors(root) {
    return [...root.querySelectorAll(
      "[class*='error']:not([class*='error-page']), [role='alert'], [aria-live='assertive'], " +
      "[class*='invalid'], [class*='validation-message']"
    )].filter(isVisible).map(innerText).filter(Boolean);
  }

  function extractSuccessIndicators() {
    const bodyText = innerText(document.body).slice(0, 2000);
    if (/application (?:was )?(?:submitted|received|complete)|thank you for applying|we.ve received your application/i.test(bodyText)) {
      return ["Application submitted"];
    }
    return [];
  }

  function detectLoading(root) {
    return Boolean(
      root.querySelector("[class*='loader'], [class*='spinner'], [class*='loading'], [aria-busy='true']") ||
      document.querySelector("[class*='loader-overlay'], .loading-overlay")
    );
  }

  // ---------------------------------------------------------------------------
  // Main observe()
  // ---------------------------------------------------------------------------

  function observe() {
    resetRegistry();
    const state = detectApplicationState();
    const root = findApplicationRoot() || document.body;

    const questions        = extractQuestions(root);
    const controls         = extractControls(root);
    const errors           = extractErrors(root);
    const successIndicators = extractSuccessIndicators();
    const loading          = detectLoading(root);

    return {
      page: {
        url: location.href,
        title: document.title,
        applicationState: state,
        hostname: location.hostname,
      },
      questions,
      controls,
      messages: [],
      errors,
      successIndicators,
      loading,
    };
  }

  function getElement(id) {
    const el = elementRegistry.get(id);
    if (!el || !document.contains(el)) return null;
    return el;
  }

  function clearRegistry() { resetRegistry(); }

  globalThis.genericObserver = { observe, getElement, clearRegistry };
}());
