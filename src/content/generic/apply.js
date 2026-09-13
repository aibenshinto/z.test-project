// Generic company-career-site adapter.
//
// This runs only after the user grants the specific company origin permission.
// It supports native form controls and explicit application workflow buttons.
// It never fills passwords, solves challenges, or guesses an unknown answer.

(() => {
  if (globalThis.genericApply) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (el) => String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  const norm = (value) => String(value || "").toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, " ").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    if (!el) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };

  function blocker() {
    const challenge = [
      "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", "iframe[src*='turnstile']",
      "[id*='captcha']", "[class*='captcha']", "[class*='cloudflare']",
    ].some((selector) => [...document.querySelectorAll(selector)].some(visible));
    if (challenge || /verify you are human|security check|access denied/i.test(text(document.body))) {
      return "Security or CAPTCHA challenge detected. The extension will not bypass it.";
    }
    if (visible(document.querySelector("input[type='password']")) && /sign in|log in/i.test(text(document.body).slice(0, 1200))) {
      return "Login page detected. Sign in manually before continuing.";
    }
    return null;
  }

  function applicationRoot() {
    return [...document.querySelectorAll("form, [role='dialog']")]
      .filter((el) => visible(el) && /application|apply|candidate|resume|cv/i.test(text(el).slice(0, 1800)))
      .sort((a, b) => b.querySelectorAll("input, textarea, select").length - a.querySelectorAll("input, textarea, select").length)[0]
      || document.querySelector("form");
  }

  function questionFor(control, root) {
    const labels = [];
    if (control.id) labels.push(...document.querySelectorAll(`label[for="${CSS.escape(control.id)}"]`));
    const group = control.closest("fieldset, [role='group'], .form-group, .field, [class*='field'], [class*='question']") || root;
    labels.push(...group.querySelectorAll("legend, label, [id$='-label'], [class*='label'], [class*='question']"));
    const aria = control.getAttribute("aria-label") || control.getAttribute("placeholder");
    return [aria, ...labels.map(text), control.name].find(Boolean)?.trim() || "";
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
      return [...root.querySelectorAll(`input[type="radio"][name="${CSS.escape(control.name)}"]`)].map(optionLabel);
    }
    if (control.type === "checkbox") return ["Yes", "No"];
    return [];
  }

  function needsValue(control) {
    if (control.type === "radio") {
      const group = control.closest("fieldset, [role='group'], .form-group, .field") || control.parentElement;
      return ![...group.querySelectorAll(`input[type="radio"][name="${CSS.escape(control.name)}"]`)].some((item) => item.checked);
    }
    if (control.type === "checkbox") return control.required && !control.checked;
    if (control.tagName === "SELECT") return !control.value;
    if (control.type === "file") return !control.files?.length;
    return !String(control.value || "").trim();
  }

  function controls(root) {
    const radioNames = new Set();
    return [...root.querySelectorAll("input, textarea, select")].filter((control) => {
      if (!visible(control) || control.disabled || control.readOnly) return false;
      if (["hidden", "submit", "button", "reset", "password"].includes(control.type)) return false;
      if (control.type === "radio") {
        if (!control.name || radioNames.has(control.name)) return false;
        radioNames.add(control.name);
      }
      return needsValue(control);
    });
  }

  function setText(control, value) {
    const proto = control.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(control, String(value));
    else control.value = String(value);
    control.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value), inputType: "insertText" }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    control.blur();
    return String(control.value || "").trim() === String(value).trim();
  }

  function setChoice(control, answer, root) {
    const wanted = norm(answer);
    if (control.tagName === "SELECT") {
      const option = [...control.options].find((item) => norm(text(item)) === wanted || norm(item.value) === wanted);
      if (!option) return false;
      control.value = option.value;
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      return control.value === option.value;
    }
    if (control.type === "radio") {
      const items = [...root.querySelectorAll(`input[type="radio"][name="${CSS.escape(control.name)}"]`)];
      const chosen = items.find((item) => {
        const label = norm(optionLabel(item));
        return label === wanted || norm(item.value) === wanted || label.includes(wanted);
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
    return setText(control, answer);
  }

  async function attachResume(control) {
    const context = await chrome.runtime.sendMessage({ type: "GET_APPLY_CONTEXT" });
    const resume = context?.resume;
    if (!resume?.b64) return false;
    const bytes = Uint8Array.from(atob(resume.b64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], resume.name, { type: resume.mime }));
    control.files = transfer.files;
    control.dispatchEvent(new Event("change", { bubbles: true }));
    return control.files.length === 1;
  }

  async function fill(control, root) {
    const question = questionFor(control, root);
    if (!question) return { waitingForUser: true, question: "An external application field has no readable label.", reason: "unlabelled external form field" };
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
    if (!setChoice(control, response.answer, root)) {
      return { waitingForUser: true, question, suggested: response.answer, profileHint: response.profileHint, reason: "stored answer does not match the available options" };
    }
    return { handled: true };
  }

  function complete() {
    return /application (?:was )?(?:submitted|received|complete)|thank you for applying/i.test(text(document.body));
  }

  function nextButton(root) {
    return [...root.querySelectorAll("button, input[type='submit']")].find((button) => {
      if (!visible(button) || button.disabled) return false;
      const label = norm(`${text(button)} ${button.value || ""} ${button.getAttribute("aria-label") || ""}`);
      return /^(next|continue|review|review application|submit application|submit)$/.test(label);
    }) || null;
  }

  function isSubmit(button) {
    return /submit/i.test(`${text(button)} ${button.value || ""} ${button.getAttribute("aria-label") || ""}`);
  }

  async function apply() {
    const initialBlocker = blocker();
    if (initialBlocker) return { submitted: false, blocked: true, reason: initialBlocker };
    for (let step = 0; step < 10; step++) {
      const currentBlocker = blocker();
      if (currentBlocker) return { submitted: false, blocked: true, reason: currentBlocker };
      if (complete()) return { submitted: true, reason: "External site confirmed submission." };
      const root = applicationRoot();
      if (!root) return { submitted: false, reason: "No recognised application form was found on the company site." };
      const fields = controls(root);
      if (!fields.length && !nextButton(root)) {
        return { submitted: false, reason: "The company application uses unsupported custom form controls." };
      }
      for (const control of fields) {
        const result = await fill(control, root);
        if (!result.handled) return { submitted: false, ...result };
      }
      const button = nextButton(root);
      if (!button) return { submitted: false, reason: "No recognised Next, Review, or Submit Application button was found." };
      const submitting = isSubmit(button);
      button.scrollIntoView({ block: "center" });
      button.click();
      await sleep(800);
      if (submitting) {
        for (let wait = 0; wait < 12; wait++) {
          if (complete()) return { submitted: true, reason: "External site confirmed submission." };
          await sleep(250);
        }
        return { submitted: false, reason: "Submit was clicked but the company site did not confirm completion." };
      }
    }
    return { submitted: false, reason: "External application exceeded its 10-step safety limit." };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "GENERIC_APPLY") return;
    apply().then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  });

  globalThis.genericApply = { apply };
})();
