// LinkedIn Easy Apply adapter. DOM-only: candidate answers, API keys, and
// application policy remain in the service worker. This adapter is bounded and
// only clicks named Easy Apply workflow controls.

/* global LINKEDIN_SEL, linkedinCheckAnomaly, linkedinVisible */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dialog() {
  return [...document.querySelectorAll(LINKEDIN_SEL.form.dialog)]
    .filter(linkedinVisible).at(-1) || null;
}

function text(el) {
  return String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
}

function norm(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9+#. ]+/g, " ").replace(/\s+/g, " ").trim();
}

function isComplete() {
  return [...document.querySelectorAll(LINKEDIN_SEL.form.completion)].some((el) =>
    linkedinVisible(el) && /application (?:was )?(?:submitted|sent)|application complete/i.test(text(el))
  );
}

function controlQuestion(control, root) {
  const labels = [];
  if (control.id) labels.push(...document.querySelectorAll(`label[for="${CSS.escape(control.id)}"]`));
  const container = control.closest("fieldset, [data-test-form-element], .fb-dash-form-element, .jobs-easy-apply-form-section__grouping, .artdeco-text-input--container") || root;
  labels.push(...container.querySelectorAll("legend, label, [id$='-label'], [class*='label']"));
  const aria = control.getAttribute("aria-label") || control.getAttribute("placeholder");
  const candidate = [aria, ...labels.map(text), control.name].find(Boolean);
  return String(candidate || "").replace(/\s+/g, " ").trim();
}

function optionLabel(control) {
  if (control.id) {
    const label = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
    if (label) return text(label);
  }
  return control.getAttribute("aria-label") || control.value || "";
}

function optionsFor(control, root) {
  if (control.tagName === "SELECT") return [...control.options].filter((o) => o.value).map((o) => text(o));
  if (control.type === "radio") {
    return [...root.querySelectorAll(`input[type='radio'][name="${CSS.escape(control.name)}"]`)].map(optionLabel);
  }
  if (control.type === "checkbox") return ["Yes", "No"];
  return [];
}

function needsValue(control) {
  if (control.type === "radio") {
    const root = control.closest("fieldset, [data-test-form-element], .fb-dash-form-element") || control.parentElement;
    return ![...root.querySelectorAll(`input[type='radio'][name="${CSS.escape(control.name)}"]`)].some((el) => el.checked);
  }
  if (control.type === "checkbox") return control.required && !control.checked;
  if (control.tagName === "SELECT") return !control.value;
  if (control.type === "file") return !control.files?.length;
  return !String(control.value || "").trim();
}

function editableControls(root) {
  const seenRadioNames = new Set();
  return [...root.querySelectorAll("input, textarea, select")].filter((control) => {
    if (!linkedinVisible(control) || control.disabled || control.readOnly) return false;
    if (["hidden", "submit", "button", "reset", "password"].includes(control.type)) return false;
    if (control.type === "radio") {
      if (!control.name || seenRadioNames.has(control.name)) return false;
      seenRadioNames.add(control.name);
    }
    return needsValue(control);
  });
}

function setValue(control, value) {
  const setter = control.tagName === "TEXTAREA"
    ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(control, String(value));
  else control.value = String(value);
  control.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
  control.blur();
  return String(control.value || "").trim() === String(value).trim();
}

function chooseOption(control, answer, root) {
  const wanted = norm(answer);
  if (control.tagName === "SELECT") {
    const option = [...control.options].find((o) => norm(text(o)) === wanted || norm(o.value) === wanted);
    if (!option) return false;
    control.value = option.value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return control.value === option.value;
  }
  if (control.type === "radio") {
    const radios = [...root.querySelectorAll(`input[type='radio'][name="${CSS.escape(control.name)}"]`)];
    const chosen = radios.find((radio) => {
      const label = norm(optionLabel(radio));
      return label === wanted || norm(radio.value) === wanted || label.includes(wanted);
    });
    if (!chosen) return false;
    chosen.click();
    return chosen.checked;
  }
  if (control.type === "checkbox") {
    const yes = /^(yes|true|agree|1)$/i.test(String(answer));
    if (control.checked !== yes) control.click();
    return control.checked === yes;
  }
  return setValue(control, answer);
}

async function attachResume(control) {
  const context = await chrome.runtime.sendMessage({ type: "GET_APPLY_CONTEXT" });
  const resume = context?.resume;
  if (!resume?.b64) return false;
  const bytes = Uint8Array.from(atob(resume.b64), (char) => char.charCodeAt(0));
  const file = new File([bytes], resume.name, { type: resume.mime });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  control.files = transfer.files;
  control.dispatchEvent(new Event("change", { bubbles: true }));
  return control.files.length === 1;
}

async function resolveAndFill(control, root) {
  const question = controlQuestion(control, root);
  if (!question) {
    return { waitingForUser: true, question: "An application field has no readable label.", reason: "unlabelled LinkedIn form field" };
  }
  if (control.type === "file") {
    if (!/resume|cv/i.test(question)) return { waitingForUser: true, question, reason: "unknown file upload requested" };
    if (await attachResume(control)) return { handled: true };
    return { waitingForUser: true, question, reason: "resume upload requested but no resume is stored" };
  }

  const response = await chrome.runtime.sendMessage({
    type: "RESOLVE_ANSWER",
    question,
    options: optionsFor(control, root),
  });
  if (!response?.ok || response.action !== "FILL" || !response.answer) {
    return {
      waitingForUser: true,
      question,
      suggested: response?.answer || "",
      confirm: response?.action === "CONFIRM",
      profileHint: response?.profileHint,
      reason: response?.action === "CONFIRM" ? "confirmation required" : "no safe answer available",
    };
  }
  if (!chooseOption(control, response.answer, root)) {
    return {
      waitingForUser: true,
      question,
      suggested: response.answer,
      profileHint: response.profileHint,
      reason: "stored answer does not match the available options",
    };
  }
  return { handled: true };
}

function workflowButton(root) {
  return [...root.querySelectorAll("button")].find((button) => {
    if (!linkedinVisible(button) || button.disabled) return false;
    const label = norm(`${text(button)} ${button.getAttribute("aria-label") || ""}`);
    return /^(next|continue to next step|review|review your application|submit application)$/.test(label);
  }) || null;
}

function isSubmit(button) {
  return /submit application/i.test(`${text(button)} ${button.getAttribute("aria-label") || ""}`);
}

async function apply() {
  const anomaly = linkedinCheckAnomaly();
  if (anomaly) return { submitted: false, blocked: true, reason: anomaly };
  if (LINKEDIN_SEL.job.externalApply()) {
    return { submitted: false, external: true, reason: "External company application; generic adapter is not enabled for this origin." };
  }

  let root = dialog();
  if (!root) {
    const button = LINKEDIN_SEL.job.easyApply();
    if (!button) return { submitted: false, reason: "No verified LinkedIn Easy Apply button found." };
    button.click();
    for (let wait = 0; wait < 20 && !root; wait++) {
      await sleep(250);
      root = dialog();
    }
  }
  if (!root) return { submitted: false, reason: "Easy Apply dialog did not open within 5 seconds." };

  for (let step = 0; step < 8; step++) {
    const blocker = linkedinCheckAnomaly();
    if (blocker) return { submitted: false, blocked: true, reason: blocker };
    if (isComplete()) return { submitted: true, reason: "LinkedIn confirmed submission." };
    root = dialog();
    if (!root) return { submitted: false, reason: "Easy Apply dialog closed before confirmation." };

    for (const control of editableControls(root)) {
      const result = await resolveAndFill(control, root);
      if (!result.handled) return { submitted: false, ...result };
    }

    const button = workflowButton(root);
    if (!button) return { submitted: false, reason: "No verified Next, Review, or Submit control found." };
    const submit = isSubmit(button);
    button.click();
    await sleep(750);
    if (submit) {
      for (let wait = 0; wait < 12; wait++) {
        if (isComplete()) return { submitted: true, reason: "LinkedIn confirmed submission." };
        await sleep(250);
      }
      return { submitted: false, reason: "Submit was clicked but LinkedIn did not confirm completion." };
    }
  }
  return { submitted: false, reason: "Easy Apply exceeded its 8-step safety limit." };
}

globalThis.linkedinApply = { apply, editableControls, controlQuestion, chooseOption };
