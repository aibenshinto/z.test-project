// Naukri application driver.
//
// Ground rule, learned from a live run: the drawer opening means NOTHING.
// Naukri reuses the same drawer for profile-completion nagging and for generic
// job recommendations, and in both cases no application is ever created. The
// only proof of success is the Apply button changing state.

/* global NAUKRI_SEL, naukriWaitFor, naukriVisible, naukriType,
          naukriApplicationSubmitted, naukriProfileIncomplete, naukriScrape */

const Q = () => NAUKRI_SEL.questionnaire;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the visible job-detail Apply button while Naukri hydrates React. */
async function waitForApplyButton(timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const button = naukriVisible(NAUKRI_SEL.job.applyButton);
    if (button && !button.disabled && /^apply$/i.test(button.innerText.trim())) return button;
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
  if (naukriVisible(Q().drawer)) return { ok: true };
  const button = await waitForApplyButton();
  if (!button) {
    return { ok: false, reason: "Naukri Apply button was not visible after waiting 12 seconds." };
  }
  button.scrollIntoView({ block: "center", inline: "center" });
  button.focus();
  button.click();

  for (let attempt = 0; attempt < 32; attempt++) {
    if (naukriApplicationSubmitted()) return { ok: true, submitted: true };
    if (naukriVisible(Q().drawer)) return { ok: true };
    const anomaly = naukriScrape.checkAnomaly();
    if (anomaly) return { ok: false, blocked: true, reason: anomaly };
    await sleep(250);
  }
  return {
    ok: false,
    reason: "Naukri Apply button was clicked, but no application drawer or submission confirmation appeared within 8 seconds.",
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

/**
 * Drive one application to completion.
 * Resolves { submitted, answered, reason } - `submitted` is authoritative and
 * derived only from page state.
 */
async function apply(job) {
  const anomaly = naukriScrape.checkAnomaly();
  if (anomaly) throw new Error(anomaly);

  if (naukriApplicationSubmitted()) {
    return { submitted: true, answered: [], reason: "already applied" };
  }

  // An external posting is not an in-place application. Hand its explicit
  // HTTPS destination to the worker, which asks the user for that origin.
  const externalControl = document.querySelector(NAUKRI_SEL.job.externalApply);
  if (externalControl) {
    const rawExternalUrl = externalControl.href || externalControl.dataset?.url || externalControl.dataset?.href || "";
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
  if (!opened.ok) return { submitted: false, answered: [], blocked: opened.blocked, reason: opened.reason };
  if (opened.submitted) return { submitted: true, answered: [], reason: "already applied" };
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

  return {
    submitted: naukriApplicationSubmitted(),
    answered,
    reason: "drawer did not confirm submission within 15 turns",
  };
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
  openApplicationDrawer, openExternalCompanySite,
};
