// Naukri application driver.
//
// Ground rule, learned from a live run: the drawer opening means NOTHING.
// Naukri reuses the same drawer for profile-completion nagging and for generic
// job recommendations, and in both cases no application is ever created. The
// only proof of success is the Apply button changing state.
//
// Two application modes coexist:
//   "agent"   — radio/form questionnaire panels handled by the AI agent loop
//               (naukriAgentLoop). This is the NEW path added by the AI agent
//               architecture.
//   "chatbot" — free-text chatbot drawer handled by the existing answerOne()
//               loop. This path is PRESERVED exactly as it was.
//
// detectApplicationMode() picks which path to use. The caller (apply()) tries
// the agent path first; if no questionnaire panel is visible it falls back to
// the chatbot path.

/* global NAUKRI_SEL, naukriWaitFor, naukriVisible, naukriType,
          naukriApplicationSubmitted, naukriProfileIncomplete, naukriScrape,
          naukriAgentLoop */

const Q = () => NAUKRI_SEL.questionnaire;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the visible job-detail Apply button while Naukri hydrates React. */
async function waitForApplyButton(timeoutMs = 20000) {
  const SEL = NAUKRI_SEL.job.applyButton;

  // Phase 1: wait until at least one matching element exists in the DOM.
  // naukriWaitFor polls every 200ms and correctly handles React hydration
  // delays — the button is absent until React mounts, not just invisible.
  const appeared = await naukriWaitFor(SEL, timeoutMs);
  if (!appeared) return null;

  // Phase 2: the element is now in the DOM. Pick the visible copy (the button
  // appears twice on the page) and verify its label is an apply-intent.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = naukriVisible(SEL);
    if (button && !button.disabled) {
      const label = String(button.innerText || button.value || "").trim().toLowerCase();
      // Accept: "Apply", "Apply Now", "Easy Apply", "Apply for Job", etc.
      // Reject: "Applied", "Already Applied", "Application Submitted" (done state).
      // Reject: "Apply on company site" (external — handled before this call).
      const isApplyIntent = /\bapply\b/.test(label)
        && !/\bapplied\b|\bsubmitted\b|\balready\b/.test(label)
        && !/company\s*site|external|company\s*website/i.test(label);
      if (isApplyIntent) return button;
    }
    await sleep(250);
  }
  return null;
}

/**
 * Open only Naukri's in-page application drawer. A successful click must
 * produce either the drawer or the platform's applied state; otherwise the
 * caller receives the exact diagnostic instead of pretending it applied.
 */
async function openApplicationDrawer() {
  // Already open states — return immediately with the correct mode.
  if (naukriApplicationSubmitted()) return { ok: true, submitted: true };
  if (naukriVisible(Q().drawer)) return { ok: true, mode: "chatbot" };
  const mode0 = detectApplicationMode();
  if (mode0 === "agent") return { ok: true, mode: "agent" };

  const button = await waitForApplyButton();
  if (!button) {
    // Produce a diagnostic that includes what button label was actually found.
    const anyBtn = naukriVisible(NAUKRI_SEL.job.applyButton);
    const foundLabel = anyBtn ? `"${String(anyBtn.innerText || "").trim()}"` : "none";
    return {
      ok: false,
      reason: `Naukri Apply button not found after 12 s. Found element with label ${foundLabel}. ` +
              "The job may already be applied, require a fresh login, or use an unsupported button flow.",
    };
  }
  // Try a DOM click first, then a real pointer sequence if Naukri ignores it.
  // A click that JavaScript accepted is not the same as one the site acted on.
  const pointer = globalThis.__autoApplyPointer;

  /** Has any of the three success states appeared? */
  function opened() {
    if (naukriApplicationSubmitted()) return { ok: true, submitted: true };
    if (naukriVisible(Q().drawer)) return { ok: true, mode: "chatbot" };
    if (detectApplicationMode() === "agent") return { ok: true, mode: "agent" };
    return null;
  }

  const methods = pointer
    ? [() => pointer.domClick(button), () => pointer.pointerClick(button)]
    : [async () => { button.scrollIntoView({ block: "center" }); button.focus(); button.click(); }];

  for (let m = 0; m < methods.length; m++) {
    if (m > 0) console.debug("[EXECUTOR] Apply DOM click had no effect — attempting pointer click");
    await methods[m]();

    // Poll for a real state transition. 24 × 250 ms = 6 s per method, so the
    // overall budget stays the 12 s the caller expects.
    for (let attempt = 0; attempt < 24; attempt++) {
      const state = opened();
      if (state) return state;
      const anomaly = naukriScrape.checkAnomaly();
      if (anomaly) return { ok: false, blocked: true, reason: anomaly };
      await sleep(250);
    }
  }

  // Nothing appeared — try to diagnose why.
  const externalBtn = document.querySelector(NAUKRI_SEL.job.externalApply);
  if (externalBtn) {
    return {
      ok: false,
      reason: "Apply button opened an external company-site redirect instead of an in-page form. The external URL will be handled separately.",
    };
  }
  return {
    ok: false,
    reason: "Naukri Apply button was clicked but no application form, questionnaire panel, or submission confirmation appeared within 12 seconds. The job may require a complete Naukri profile or may use an unsupported application flow.",
  };
}

/** Latest unanswered bot message in the drawer. */
function currentQuestion() {
  const msgs = [...document.querySelectorAll(Q().botMessage)];
  const last = msgs[msgs.length - 1];
  return last ? last.innerText.trim().replace(/\s+/g, " ") : null;
}

/** Click Naukri's explicit external-company control; navigation is observed by
 * the worker because this document may unload immediately after the click. */
function openExternalCompanySite() {
  const control = document.querySelector(NAUKRI_SEL.job.externalApply);
  if (!control) return { clicked: false, reason: "Naukri company-site button was not found." };
  control.scrollIntoView({ block: "center", inline: "center" });
  control.focus();
  control.click();
  return { clicked: true };
}

/**
 * Naukri's questions are templated. Collapsing them to a template lets one
 * cached answer serve every variant, which is most of the cache hit rate.
 *   "How much experience do you have in Django?" -> experience_in:{skill}
 */
function classify(question) {
  const q = question.toLowerCase();
  let m;
  if ((m = q.match(/how much experience do you have in (.+?)\?/))) {
    return { kind: "experience_in", skill: m[1].trim(), template: "experience_in:{skill}" };
  }
  if (/what is your current location/.test(q))       return { kind: "current_location" };
  if (/what are your preferred locations/.test(q))   return { kind: "preferred_locations" };
  if (/upload your resume/.test(q))                  return { kind: "resume_upload" };
  if (/write a headline/.test(q))                    return { kind: "headline" };
  return { kind: "freeform", template: question };
}

/** Resolve an answer from the profile before ever calling a model. */
function answerFromProfile(cls, profile) {
  switch (cls.kind) {
    case "experience_in": {
      const want = cls.skill.toLowerCase();

      // Explicitly disclaimed skills answer 0, always. This is separate from
      // "not listed" so it cannot be quietly reintroduced by a profile edit,
      // a re-parse, or a model fallback.
      if ((profile.excludedSkills || []).some((s) => s.toLowerCase() === want)) {
        return "0";
      }

      const skill = (profile.skills || []).find((s) => s.name.toLowerCase() === want);
      // A skill omitted from a resume is ambiguous. Do not declare zero years
      // unless the candidate explicitly disclaimed the skill above.
      return skill ? String(skill.years) : null;
    }
    case "current_location":    return profile.location || null;
    case "preferred_locations": return (profile.preferredLocations || []).join(", ") || null;
    case "headline":            return profile.headline || null;
    default:                    return null;
  }
}

async function answerOne(question, profile, resumeFile) {
  const cls = classify(question);
  const T = naukriType;

  if (cls.kind === "resume_upload") {
    const input = document.querySelector(Q().fileInput);
    if (!input || !resumeFile) return { handled: false, reason: "no resume on file" };
    return { handled: T.attachFile(input, resumeFile), via: "file" };
  }

  let value = answerFromProfile(cls, profile);

  if (value === null) {
    // Cache, then model. Round-trips through the worker: content scripts have
    // no direct access to the answer bank or API keys.
    const res = await chrome.runtime.sendMessage({
      type: "RESOLVE_ANSWER",
      question,
      classification: cls,
    });
    if (!res || !res.ok || res.action === "ASK" || res.action === "CONFIRM" || !res.answer) {
      return {
        handled: false,
        waitingForUser: true,
        confirm: res && res.action === "CONFIRM",
        suggested: res && res.answer,
        profileHint: res && res.profileHint,
        reason: "unanswerable: " + question,
      };
    }
    value = res.answer;
  }

  const input = await naukriWaitFor(Q().input, 8000);
  if (!input) return { handled: false, reason: "drawer input not found" };

  const typed = await T.typeInto(input, value);
  if (!typed) return { handled: false, reason: "typing did not register" };

  const btn = T.commitButton();
  if (btn) btn.click();
  else T.pressEnter(input);

  return { handled: true, value, via: "typed" };
}

// ---------------------------------------------------------------------------
// Application mode detection
// ---------------------------------------------------------------------------

/**
 * Determine which application path is appropriate for the current DOM:
 *   "agent"   — a radio/select questionnaire panel is visible (new AI path)
 *   "chatbot" — the Naukri chatbot drawer is visible (existing text path)
 *   "done"    — already submitted
 *   "unknown" — neither; caller should wait or retry
 */
function detectApplicationMode() {
  if (naukriApplicationSubmitted()) return "done";

  // Radio/form questionnaire panels — Naukri's multi-choice style
  const hasQuestionnaire =
    document.querySelector(".singleselect-radiobutton") ||
    document.querySelector(".ssrc__radio-btn-container") ||
    document.querySelector("[class*='questionnaire']") ||
    document.querySelector("[class*='Questionnaire']");
  if (hasQuestionnaire) return "agent";

  // Chatbot drawer (existing free-text path)
  if (naukriVisible(Q().drawer)) return "chatbot";

  return "unknown";
}

/**
 * Find the "Apply on company site" external button, if present.
 * Naukri renders this in several ways:
 *   <button id="company-site-button">Apply on company site</button>
 *   <a id="company-site-button" href="...">Apply on company site</a>
 *   <button class="...">Apply on company site</button>  (no stable ID)
 * We match by CSS selector first (most reliable), then fall back to text.
 */
function findExternalButton() {
  const bySelector = document.querySelector(NAUKRI_SEL.job.externalApply);
  if (bySelector) return bySelector;
  // Text-based fallback: any visible button/link that mentions "company site".
  return [...document.querySelectorAll("button, a")].find((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const t = String(el.innerText || el.textContent || "").toLowerCase().trim();
    return /apply.*(company|company site|external)/.test(t) || /company site/.test(t);
  }) || null;
}

async function persistApplyTrace(entry) {
  const { applyTrace = [] } = await chrome.storage.local.get("applyTrace");
  applyTrace.push({
    at: Date.now(),
    ...entry
  });
  await chrome.storage.local.set({
    applyTrace: applyTrace.slice(-100)
  });
}

/**
 * Executes a single job application attempt.
 * Relies entirely on DOM state, making it stateless between restarts.
 * Returns { submitted: boolean, answered: Question[], reason?: string }
 *
 * CRITICAL: do not throw on expected errors (profile incomplete, navigation).
 * Return an object so the engine can record the outcome. Throw only for
 * critical unexpected states that should halt the entire loop.
 *
 * It is vital that this function never returns { submitted: true } unless
 * the DOM proves it. If uncertain, return false. False positives destroy
 * the integrity of the run; false negatives just mean we try again or skip.
 * Therefore, "did the UI change?" is not enough. The final confirmation is
 * derived only from page state.
 */
async function apply(job) {
  const traceEntry = { stage: "apply.js_entry", site: job?.site, jobId: job?.id, title: job?.title, company: job?.company };
  console.log("[APPLY_TRACE]", JSON.stringify(traceEntry));
  await persistApplyTrace(traceEntry);
  const S = NAUKRI_SEL;
  const anomaly = naukriScrape.checkAnomaly();
  if (anomaly) throw new Error(anomaly);

  if (naukriApplicationSubmitted()) {
    return { submitted: true, answered: [], reason: "already applied" };
  }

  // An external posting is not an in-place application. Hand its explicit
  // HTTPS destination to the worker, which asks the user for that origin.
  const externalControl = findExternalButton();
  if (externalControl) {
    // Try all plausible URL carriers: href, data-url, data-href, data-redirect-url.
    const rawExternalUrl =
      externalControl.getAttribute("href") ||
      externalControl.dataset?.url ||
      externalControl.dataset?.href ||
      externalControl.dataset?.redirectUrl ||
      "";
    let externalUrl = "";
    try {
      const candidate = new URL(rawExternalUrl, location.href);
      if (candidate.protocol === "https:") externalUrl = candidate.href;
    } catch {
      // The generic adapter never receives a malformed or non-HTTPS URL.
    }
    return {
      submitted: false,
      answered: [],
      external: true,
      externalUrl,
      reason: externalUrl
        ? "External company application requires permission for its website."
        : "External company application has no readable destination URL.",
    };
  }

  const { profile, resumeFile } = await loadContext();

  // Never type model-invented data into a live employer's form.
  if (!profile || !profile._validation || !profile._validation.ok) {
    return {
      submitted: false, answered: [], halt: true,
      reason: "HALT: profile failed validation - refusing to submit invented data",
    };
  }

  const opened = await openApplicationDrawer();
  if (!opened.ok) {
    const res = { submitted: false, answered: [], blocked: opened.blocked, reason: opened.reason };
    const traceFail = { stage: "apply.js_openDrawer_fail", result: res };
    console.log("[APPLY_TRACE]", JSON.stringify(traceFail));
    await persistApplyTrace(traceFail);
    return res;
  }
  if (opened.submitted) {
    const res = { submitted: true, answered: [], reason: "already applied" };
    const traceOk = { stage: "apply.js_openDrawer_submitted", result: res };
    console.log("[APPLY_TRACE]", JSON.stringify(traceOk));
    await persistApplyTrace(traceOk);
    return res;
  }

  // Route to the correct application path based on what openApplicationDrawer detected.
  // This avoids a second DOM walk and is immune to race conditions between
  // the drawer click and the questionnaire panel animating in.
  const mode = opened.mode || detectApplicationMode();
  if (mode === "agent") {
    const traceAgentStart = { stage: "apply.js_agent_loop_start" };
    console.log("[APPLY_TRACE]", JSON.stringify(traceAgentStart));
    await persistApplyTrace(traceAgentStart);
    const res = await naukriAgentLoop.runAgentLoop({ resumeFile });
    const traceAgentEnd = { stage: "apply.js_agent_loop_end", result: res };
    console.log("[APPLY_TRACE]", JSON.stringify(traceAgentEnd));
    await persistApplyTrace(traceAgentEnd);
    return res;
  }

  const answered = [];
  const seen = new Set();

  // Bounded loop: never let a conversational bot run forever.
  for (let turn = 0; turn < 15; turn++) {
    await new Promise((r) => setTimeout(r, 1200));

    if (naukriApplicationSubmitted()) {
      return { submitted: true, answered, reason: "confirmed by apply button state" };
    }

    // The profile-completion trap. Every further attempt this run fails the
    // same way, so stop the whole run rather than burning through the queue.
    if (naukriProfileIncomplete()) {
      return {
        submitted: false, answered,
        reason: "HALT: Naukri profile incomplete - needs resume and headline on file",
        halt: true,
      };
    }

    if (/\/mnjuser\/profile/.test(location.pathname)) {
      return { submitted: false, answered, reason: "HALT: redirected to profile completion", halt: true };
    }

    const q = currentQuestion();
    if (!q) continue;
    if (seen.has(q)) continue;       // bot repeated itself; wait for it to move on
    seen.add(q);

    const r = await answerOne(q, profile, resumeFile);
    answered.push({ question: q, ...r });
    if (!r.handled) {
      return {
        submitted: false,
        answered,
        waitingForUser: Boolean(r.waitingForUser),
        question: q,
        suggested: r.suggested || "",
        confirm: Boolean(r.confirm),
        profileHint: r.profileHint || null,
        reason: r.reason,
      };
    }
  }

  const res = {
    submitted: naukriApplicationSubmitted(),
    answered,
    reason: "drawer did not confirm submission within 15 turns",
  };
  const traceFallback = { stage: "apply.js_fallback_finished", result: res };
  console.log("[APPLY_TRACE]", JSON.stringify(traceFallback));
  await persistApplyTrace(traceFallback);
  return res;
}

async function loadContext() {
  const res = await chrome.runtime.sendMessage({ type: "GET_APPLY_CONTEXT" });
  let resumeFile = null;
  if (res && res.resume) {
    const bytes = Uint8Array.from(atob(res.resume.b64), (c) => c.charCodeAt(0));
    resumeFile = new File([bytes], res.resume.name, { type: res.resume.mime });
  }
  return { profile: (res && res.profile) || {}, resumeFile };
}

async function continueApply(job, providedAnswer) {
  if (providedAnswer) {
    const T = naukriType;
    const input = await naukriWaitFor(Q().input, 8000);
    if (input) {
      await T.typeInto(input, providedAnswer);
      const btn = T.commitButton();
      if (btn) btn.click();
      else T.pressEnter(input);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return apply(job);
}

globalThis.naukriApply = {
  apply, continueApply, classify, currentQuestion, answerFromProfile,
  openApplicationDrawer, openExternalCompanySite, detectApplicationMode, findExternalButton,
};
