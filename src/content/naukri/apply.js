// Naukri application driver.
//
// Ground rule, learned from a live run: the drawer opening means NOTHING.
// Naukri reuses the same drawer for profile-completion nagging and for generic
// job recommendations, and in both cases no application is ever created. The
// only proof of success is the Apply button changing state.

/* global NAUKRI_SEL, naukriWaitFor, naukriVisible, naukriType,
          naukriApplicationSubmitted, naukriProfileIncomplete, naukriScrape */

const Q = () => NAUKRI_SEL.questionnaire;

/** Latest unanswered bot message in the drawer. */
function currentQuestion() {
  const msgs = [...document.querySelectorAll(Q().botMessage)];
  const last = msgs[msgs.length - 1];
  return last ? last.innerText.trim().replace(/\s+/g, " ") : null;
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
      // Unknown skill: report 0 rather than inventing experience.
      return String(skill ? skill.years : 0);
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
    if (!res || !res.ok || !res.answer) {
      return { handled: false, reason: "unanswerable: " + question };
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

  // An external posting is not an in-place application. Hand it back.
  if (document.querySelector(NAUKRI_SEL.job.externalApply)) {
    return { submitted: false, answered: [], reason: "external ATS - not applicable in place" };
  }

  const btn = naukriVisible(NAUKRI_SEL.job.applyButton);
  if (!btn) return { submitted: false, answered: [], reason: "no visible apply button" };
  btn.click();

  const { profile, resumeFile } = await loadContext();

  // Never type model-invented data into a live employer's form.
  if (!profile || !profile._validation || !profile._validation.ok) {
    return {
      submitted: false, answered: [], halt: true,
      reason: "HALT: profile failed validation - refusing to submit invented data",
    };
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
      return { submitted: false, answered, reason: r.reason };
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

globalThis.naukriApply = { apply, classify, currentQuestion, answerFromProfile };
