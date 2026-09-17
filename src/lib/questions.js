// Question normalization, similarity, and sensitivity.
// Pure module: no chrome, no DOM. Used by the answer bank and tests.

const STOP = new Set([
  "a", "an", "the", "is", "are", "was", "were", "do", "does", "did", "you",
  "your", "to", "of", "in", "for", "with", "on", "at", "and", "or", "be",
  "have", "has", "will", "can", "please", "what", "how", "many", "much",
]);

const ALIAS_GROUPS = [
  ["visa sponsorship", "require sponsorship", "need sponsorship", "h1b", "work visa"],
  ["work authorization", "authorized to work", "legally authorized", "eligible to work"],
  ["willing to relocate", "relocate", "relocation"],
  ["notice period", "notice"],
  ["current salary", "ctc", "current ctc", "present compensation"],
  ["expected salary", "salary expectation", "expected ctc", "desired compensation"],
  ["willing to travel", "travel required"],
  ["remote", "work from home", "wfh"],
];

const SENSITIVE = [
  /visa|sponsor|h-?1b|work authori/i,
  /criminal|felony|conviction|background check/i,
  /disabilit|veteran|gender|race|ethnicity|sexual orientation/i,
  /\bage\b|date of birth|d\.?o\.?b/i,
  /salary|compensation|ctc|notice period/i,
  /relocat/i,
  /citizen|nationality|passport/i,
  /export control|itars|security clearance/i,
  /consent|agree(?:ment)?|certif(?:y|ication)|declaration|acknowledg/i,
];

export function normalizeQuestion(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(q) {
  return normalizeQuestion(q).split(" ").filter((t) => t && !STOP.has(t));
}

export function jaccard(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function aliasBoost(a, b) {
  const na = normalizeQuestion(a);
  const nb = normalizeQuestion(b);
  for (const group of ALIAS_GROUPS) {
    const hitA = group.some((g) => na.includes(g));
    const hitB = group.some((g) => nb.includes(g));
    if (hitA && hitB) return 0.35;
  }
  return 0;
}

/** Similarity in 0..1. Exact normalize match is 1. */
export function questionSimilarity(a, b) {
  if (normalizeQuestion(a) === normalizeQuestion(b)) return 1;
  return Math.min(1, jaccard(a, b) + aliasBoost(a, b));
}

export function isSensitiveQuestion(q) {
  return SENSITIVE.some((re) => re.test(q || ""));
}

/**
 * Find the best cached entry. `bank` is { [normKey]: { question, answer, ... } }.
 * @returns {{ key: string, entry: object, similarity: number } | null}
 */
export function findSimilarAnswer(bank, question, threshold = 0.72) {
  if (!bank || !question) return null;
  const exact = bank[normalizeQuestion(question)];
  if (exact) return { key: normalizeQuestion(question), entry: exact, similarity: 1 };

  let best = null;
  for (const [key, entry] of Object.entries(bank)) {
    const probe = entry.question || key;
    const s = questionSimilarity(question, probe);
    if (s >= threshold && (!best || s > best.similarity)) {
      best = { key, entry, similarity: s };
    }
  }
  return best;
}

/**
 * Coarse classification of a screening question, by its wording alone.
 */
export function classifyQuestion(question) {
  const q = (question || "").toLowerCase();
  let m;
  if ((m = q.match(/experience (?:do you have|have you) (?:in|with) (.+?)\??$/))) {
    return { kind: "experience_in", skill: m[1].trim() };
  }
  if ((m = q.match(/how many years .{0,40}(?:in|with) (.+?)\??$/))) {
    return { kind: "experience_in", skill: m[1].trim() };
  }
  if (/current location|where do you (live|reside)/.test(q)) return { kind: "current_location" };
  if (/preferred location/.test(q)) return { kind: "preferred_locations" };
  if (/notice period/.test(q)) return { kind: "notice_period" };
  if (/visa sponsor|need sponsorship|require sponsorship/.test(q)) return { kind: "visa_sponsorship" };
  if (/authorized to work|work authori/.test(q)) return { kind: "work_auth" };
  if (/willing to relocate|relocat/.test(q)) return { kind: "relocate" };
  if (/expected salary|salary expectation|expected ctc/.test(q)) return { kind: "salary_expectation" };
  if (/full name|your name/.test(q)) return { kind: "full_name" };
  if (/first name|given name/.test(q)) return { kind: "first_name" };
  if (/last name|family name|surname/.test(q)) return { kind: "last_name" };
  if (/e-?mail/.test(q)) return { kind: "email" };
  if (/phone|mobile/.test(q)) return { kind: "phone" };
  if (/upload.{0,20}resume|attach.{0,20}cv/.test(q)) return { kind: "resume_upload" };
  if (/headline/.test(q)) return { kind: "headline" };
  return { kind: "freeform" };
}

/** Profile-derived answers that do not require a model. Null = unknown, do not guess. */
export function answerFromProfile(cls, profile) {
  if (!profile) return null;
  switch (cls.kind) {
    case "experience_in": {
      const want = (cls.skill || "").toLowerCase();
      if ((profile.excludedSkills || []).some((s) => String(s).toLowerCase() === want)) {
        return "0";
      }
      const skill = (profile.skills || []).find((s) => s.name.toLowerCase() === want);
      // A missing skill is not evidence of zero experience. Pause so the user
      // can decide rather than making a potentially false declaration.
      return skill ? String(skill.years) : null;
    }
    case "current_location":
      return profile.location || null;
    case "preferred_locations":
      return (profile.preferredLocations || []).join(", ") || null;
    case "headline":
      return profile.headline || null;
    case "full_name":
      return profile.fullName || null;
    case "first_name":
      return profile.fullName?.trim().split(/\s+/)[0] || null;
    case "last_name": {
      const parts = profile.fullName?.trim().split(/\s+/).filter(Boolean) || [];
      return parts.length > 1 ? parts.slice(1).join(" ") : null;
    }
    case "email":
      return profile.email || null;
    case "phone":
      return profile.phone || null;
    case "notice_period":
      return profile.noticePeriodDays != null ? String(profile.noticePeriodDays) : null;
    case "work_auth":
      return profile.workAuthorization || null;
    case "visa_sponsorship":
      return profile.visaSponsorship || null;
    case "relocate":
      return profile.willingToRelocate == null
        ? null
        : profile.willingToRelocate ? "Yes" : "No";
    case "salary_expectation":
      return profile.salaryExpectation || null;
    default:
      return null;
  }
}

/**
 * Where an unanswered but profile-backed question should be edited in the
 * side panel. Free-form/legal questions deliberately return null: they belong
 * in the user-sourced answer bank, not in a guessed profile field.
 */
export function profileHintForQuestion(question) {
  const cls = classifyQuestion(question);
  const simple = {
    current_location: ["pLocation", "Current location"],
    preferred_locations: ["pPreferred", "Preferred locations"],
    notice_period: ["pNotice", "Notice period"],
    work_auth: ["pWorkAuth", "Work authorization"],
    visa_sponsorship: ["pVisa", "Visa sponsorship requirement"],
    relocate: ["pRelocate", "Willingness to relocate"],
    salary_expectation: ["pSalaryExpectation", "Salary expectation"],
    full_name: ["pName", "Full name"],
    first_name: ["pName", "Full name"],
    last_name: ["pName", "Full name"],
    email: ["pEmail", "Email"],
    phone: ["pPhone", "Phone"],
    headline: ["pHeadline", "Headline"],
  };
  if (cls.kind === "experience_in") {
    return {
      fieldId: "pSkills",
      label: "Skills",
      help: `Add ${cls.skill} in the format “${cls.skill}: years”.`,
    };
  }
  const target = simple[cls.kind];
  return target ? { fieldId: target[0], label: target[1], help: `Complete the ${target[1]} field.` } : null;
}
