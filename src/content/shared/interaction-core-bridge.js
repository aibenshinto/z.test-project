// Bridge: expose the pure interaction-core logic to content scripts.
//
// `src/lib/interaction-core.js` is an ES module so it can be unit-tested with
// `node --test` and imported by the service worker. Content scripts in this
// extension are classic scripts loaded via manifest `js: [...]`, which cannot
// use `import`. Rather than duplicate the logic (which would let the two
// copies drift), this bridge loads the module through the extension URL and
// publishes it on globalThis.
//
// The load is asynchronous, so a synchronous fallback implementation is
// installed first. `tests/interaction-core.test.js` asserts the fallback and
// the module agree, so a change to one without the other fails the suite.

(function () {
  if (globalThis.__autoApplyInteractionCore?.loaded) return; // idempotent guard

  // ---- Synchronous fallback -------------------------------------------------
  // Mirrors src/lib/interaction-core.js. Keep the two in step; the test suite
  // enforces it.

  const ACTION_RESULT = Object.freeze({
    EXECUTED: "ACTION_EXECUTED",
    CONFIRMED: "ACTION_CONFIRMED",
    NO_EFFECT: "ACTION_NO_EFFECT",
    FAILED: "ACTION_FAILED",
    STALE: "ACTION_STALE",
  });

  const APPLICATION_STATUS = Object.freeze({
    SUBMITTED: "APPLICATION_SUBMITTED",
    UNKNOWN: "APPLICATION_STATUS_UNKNOWN",
    NOT_SUBMITTED: "APPLICATION_NOT_SUBMITTED",
  });

  const MAX_CLICK_RETRIES = 3;

  const APPLY_INTENT_PATTERNS = [
    /\beasy\s*apply\b/i, /\bapply\s*now\b/i, /\bapply\b/i, /\bapplication\b/i,
    /\bstart\s+(?:your\s+)?applic/i, /\bstart\s+applying\b/i,
    /\bbegin\s+(?:your\s+)?applic/i, /\bcontinue\s+(?:your\s+)?applic/i,
    /\bsubmit\s+(?:your\s+)?applic/i, /\bget\s+started\b/i, /\bstart\b/i,
    /\bproceed\b/i, /\bcontinue\b/i, /\bnext(?:\s+step)?\b/i,
  ];

  const STRONG_APPLY_PATTERNS = [
    /\beasy\s*apply\b/i, /\bapply\s*now\b/i, /\bapply\s+to\s+this\s+job\b/i,
    /\bstart\s+(?:your\s+)?applic/i, /\bbegin\s+(?:your\s+)?applic/i,
    /\bcontinue\s+(?:your\s+)?applic/i,
  ];

  const SUBMISSION_PATTERNS = [
    /\byour application (?:was|has been) (?:sent|submitted|received)\b/i,
    /\bapplication (?:was|has been) (?:submitted|sent|received)\b/i,
    /\bapplication (?:submitted|received)\b/i,
    /\bthank you for applying\b/i,
    /\bthank you for your application\b/i,
    /\bwe(?:'|’)?ve received your application\b/i,
    /\bwe have received your application\b/i,
    /\byour application is complete\b/i,
    /\bsuccessfully submitted\b/i,
    /\bapplication submitted successfully\b/i,
    /\bapplication confirmation\b/i,
  ];

  const SUBMISSION_DISQUALIFIERS = [
    /\bapplication (?:was |has been )?(?:sent|submitted|received)\b[^.]{0,20}\b\d+\s*(?:second|minute|hour|day|week|month)s?\s+ago\b/i,
    /\b\d+\s+of\s+\d+\b/i,
    /\b(?:similar|recommended|related|other|more)\s+jobs?\b/i,
    /\bpeople also (?:viewed|applied)\b/i,
  ];

  const PROGRESS_PATTERNS = [
    /\bnext\b/i, /\breview\b/i, /\bcontinue\b/i, /\bsubmit application\b/i,
    /\bapplication sent\?*$/i,
  ];

  const SECURITY_PATTERNS = [
    /\bcaptcha\b/i, /\brecaptcha\b/i, /\bhcaptcha\b/i, /\bturnstile\b/i,
    /\bverify (?:you are|you're) (?:a )?human\b/i, /\bi'?m not a robot\b/i,
    /\bsecurity (?:check|challenge|verification)\b/i, /\bsuspicious activity\b/i,
    /\bunusual activity\b/i, /\bare you a robot\b/i, /\baccess denied\b/i,
    /\bchallenge required\b/i,
  ];

  function accessibleName(el) {
    if (!el) return "";
    return [el.text, el.ariaLabel, el.title, el.value, el.name, el.placeholder]
      .filter((s) => typeof s === "string" && s.trim())
      .join(" ").replace(/\s+/g, " ").trim();
  }

  function rankApplyIntent(el) {
    const name = accessibleName(el);
    if (!name) return 0;
    let score = 0;
    if (STRONG_APPLY_PATTERNS.some((re) => re.test(name))) score = 0.9;
    else if (APPLY_INTENT_PATTERNS.some((re) => re.test(name))) score = 0.5;
    if (!score) return 0;
    const tag = String(el.tag || "").toLowerCase();
    const role = String(el.role || "").toLowerCase();
    if (tag === "button" || role === "button" || tag === "a" || role === "link") score += 0.1;
    if (el.disabled || el.enabled === false) score *= 0.3;
    if (el.visible === false) score *= 0.2;
    return Math.max(0, Math.min(1, score));
  }

  function findApplyCandidates(elements, limit = 5) {
    if (!Array.isArray(elements)) return [];
    return elements
      .map((el) => ({ id: el.id, name: accessibleName(el), score: rankApplyIntent(el) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  function diffPageState(before, after) {
    const changes = [];
    if (!before || !after) return { changed: false, changes };
    if (before.url !== after.url) changes.push("url");
    if (before.title !== after.title) changes.push("title");
    if (Boolean(before.modalOpen) !== Boolean(after.modalOpen)) changes.push("modal");
    if (before.applicationState !== after.applicationState) changes.push("applicationState");
    if (before.bodyTextHash !== after.bodyTextHash) changes.push("content");
    if (Number(before.controlCount) !== Number(after.controlCount)) changes.push("controlCount");
    if (Number(before.fieldCount) !== Number(after.fieldCount)) changes.push("fieldCount");
    if (Number(before.errorCount ?? 0) !== Number(after.errorCount ?? 0)) changes.push("errors");
    return { changed: changes.length > 0, changes };
  }

  function hasSubmissionEvidence(text) {
    if (!text) return false;
    for (const re of SUBMISSION_PATTERNS) {
      const match = re.exec(text);
      if (!match) continue;
      const from = Math.max(0, match.index - 60);
      const context = text.slice(from, match.index + match[0].length + 60);
      if (SUBMISSION_DISQUALIFIERS.some((bad) => bad.test(context))) continue;
      return true;
    }
    return false;
  }

  function hasProgressEvidence(text) {
    if (!text) return false;
    return PROGRESS_PATTERNS.some((re) => re.test(text));
  }

  function classifyApplicationStatus(evidence = {}) {
    const {
      adapterConfirmed = false, pageText = "",
      successIndicators = [], agentClaimedFinish = false,
    } = evidence;
    if (adapterConfirmed) {
      return { status: APPLICATION_STATUS.SUBMITTED, reason: "Confirmed by the platform adapter's own submission check" };
    }
    const indicatorText = (successIndicators || []).join(" ");
    if (hasSubmissionEvidence(pageText) || hasSubmissionEvidence(indicatorText)) {
      return { status: APPLICATION_STATUS.SUBMITTED, reason: "Confirmed by an explicit submission confirmation message" };
    }
    if (hasProgressEvidence(pageText)) {
      return {
        status: APPLICATION_STATUS.UNKNOWN,
        reason: agentClaimedFinish
          ? "The agent reported finish, but the page still shows application steps rather than a confirmation"
          : "The application appears to be in progress; no submission confirmation was found",
      };
    }
    if (agentClaimedFinish) {
      return { status: APPLICATION_STATUS.UNKNOWN, reason: "The agent reported finish but no submission confirmation was found on the page" };
    }
    return { status: APPLICATION_STATUS.UNKNOWN, reason: "No submission confirmation was observed" };
  }

  function classifyClickOutcome({ executed, before, after, targetGone = false }) {
    if (!executed) {
      return { result: ACTION_RESULT.FAILED, changes: [], reason: "the click could not be dispatched" };
    }
    const { changes } = diffPageState(before, after);
    const STRUCTURAL = ["url", "title", "modal", "applicationState", "controlCount", "fieldCount", "errors"];
    if (changes.some((c) => STRUCTURAL.includes(c))) {
      return { result: ACTION_RESULT.CONFIRMED, changes, reason: `the page changed (${changes.join(", ")})` };
    }
    if (targetGone) {
      return { result: ACTION_RESULT.CONFIRMED, changes: ["targetRemoved"], reason: "the target element was removed from the page after the click" };
    }
    return {
      result: ACTION_RESULT.NO_EFFECT,
      changes,
      reason: changes.length
        ? `the click was dispatched but only incidental content changed (${changes.join(", ")})`
        : "the click was dispatched but the page did not change",
    };
  }

  function nextClickStrategy(outcome, attempt, maxRetries = MAX_CLICK_RETRIES) {
    if (outcome === ACTION_RESULT.CONFIRMED) return { next: "continue", method: null };
    if (attempt + 1 >= maxRetries) return { next: "reassess", method: null };
    if (outcome === ACTION_RESULT.STALE) return { next: "retry", method: "reresolve_then_pointer" };
    return { next: "retry", method: attempt === 0 ? "pointer_click" : "reresolve_then_pointer" };
  }

  function pointerPointFor(rect, viewport) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    let x = rect.x + rect.width / 2;
    let y = rect.y + rect.height / 2;
    if (viewport && viewport.width > 0 && viewport.height > 0) {
      const right = rect.x + rect.width;
      const bottom = rect.y + rect.height;
      if (right <= 0 || bottom <= 0 || rect.x >= viewport.width || rect.y >= viewport.height) return null;
      x = (Math.max(rect.x, 0) + Math.min(right, viewport.width)) / 2;
      y = (Math.max(rect.y, 0) + Math.min(bottom, viewport.height)) / 2;
      x = Math.min(Math.max(x, 1), viewport.width - 1);
      y = Math.min(Math.max(y, 1), viewport.height - 1);
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function normalizeText(s) {
    return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function isStaleTarget(expected, actual) {
    if (!actual || actual.connected === false) {
      return { stale: true, reason: "element is no longer attached to the document" };
    }
    if (!expected) return { stale: false, reason: "" };
    if (expected.tag && actual.tag && expected.tag !== actual.tag) {
      return { stale: true, reason: `tag changed from ${expected.tag} to ${actual.tag}` };
    }
    if (expected.role && actual.role && expected.role !== actual.role) {
      return { stale: true, reason: `role changed from ${expected.role} to ${actual.role}` };
    }
    const wanted = normalizeText(accessibleName(expected));
    const got = normalizeText(accessibleName(actual));
    if (wanted && got && !got.includes(wanted) && !wanted.includes(got)) {
      return { stale: true, reason: `label changed from "${wanted}" to "${got}"` };
    }
    if (actual.rect && !(actual.rect.width > 0 && actual.rect.height > 0)) {
      return { stale: true, reason: "element no longer has a visible bounding box" };
    }
    return { stale: false, reason: "" };
  }

  function scoreCandidateMatch(expected, candidate) {
    if (!expected || !candidate) return 0;
    const wantedName = normalizeText(accessibleName(expected));
    const candName = normalizeText(accessibleName(candidate));
    let score = 0;
    if (wantedName && candName) {
      if (wantedName === candName) score += 0.5;
      else if (candName.includes(wantedName) || wantedName.includes(candName)) score += 0.3;
      else return 0;
    } else if (wantedName || candName) {
      return 0;
    } else {
      if (!expected.rect || !candidate.rect) return 0;
      const dx = Math.abs((expected.rect.x || 0) - (candidate.rect.x || 0));
      const dy = Math.abs((expected.rect.y || 0) - (candidate.rect.y || 0));
      if (dx > 8 || dy > 8) return 0;
      score += 0.5;
    }
    if (expected.tag && candidate.tag && expected.tag === candidate.tag) score += 0.15;
    if (expected.role && candidate.role && expected.role === candidate.role) score += 0.15;
    if (expected.type && candidate.type && expected.type === candidate.type) score += 0.1;
    if (expected.name && candidate.name && expected.name === candidate.name) score += 0.1;
    if (expected.rect && candidate.rect) {
      const dx = Math.abs((expected.rect.x || 0) - (candidate.rect.x || 0));
      const dy = Math.abs((expected.rect.y || 0) - (candidate.rect.y || 0));
      if (dx < 120 && dy < 120) score += 0.1;
    }
    return Math.max(0, Math.min(1, score));
  }

  function resolveLogicalTarget(expected, candidates, threshold = 0.45) {
    if (!expected || !Array.isArray(candidates)) return null;
    let best = null;
    for (const cand of candidates) {
      const score = scoreCandidateMatch(expected, cand);
      if (score >= threshold && (!best || score > best.score)) best = { id: cand.id, score };
    }
    return best;
  }

  function detectSecurityChallenge(signals = {}) {
    const { pageText = "", frameSources = [], passwordFieldVisible = false } = signals;
    for (const src of frameSources) {
      if (/recaptcha|hcaptcha|turnstile|captcha|checkpoint/i.test(String(src))) {
        return { blocked: true, kind: "captcha", reason: "A CAPTCHA or security challenge frame is present. The agent will not attempt to solve or bypass it." };
      }
    }
    if (SECURITY_PATTERNS.some((re) => re.test(pageText))) {
      return { blocked: true, kind: "challenge", reason: "A security or verification challenge was detected. The agent will not attempt to bypass it." };
    }
    if (passwordFieldVisible && /\bsign in\b|\blog ?in\b/i.test(pageText)) {
      return { blocked: true, kind: "login", reason: "A login wall was detected. Please sign in manually, then resume." };
    }
    return { blocked: false, kind: null, reason: "" };
  }

  globalThis.__autoApplyInteractionCore = {
    loaded: true,
    ACTION_RESULT, APPLICATION_STATUS, MAX_CLICK_RETRIES,
    accessibleName, rankApplyIntent, findApplyCandidates,
    diffPageState, hasSubmissionEvidence, hasProgressEvidence,
    classifyApplicationStatus, classifyClickOutcome, nextClickStrategy,
    pointerPointFor, isStaleTarget, scoreCandidateMatch, resolveLogicalTarget,
    detectSecurityChallenge,
  };
}());
