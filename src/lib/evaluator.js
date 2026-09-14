// Job suitability. Heuristic first (no API), optional LLM for the shortlist.
// Conservative: under-experience is a SKIP, not a stretch APPLY.

import { heuristicScore } from "./ranker.js";

const EXP_RE = /(\d+)\s*-\s*(\d+)\s*yrs?/i;

function parseExperience(s) {
  const m = (s || "").match(EXP_RE);
  return m ? { min: +m[1], max: +m[2] } : null;
}

/**
 * @returns {{
 *   match_score: number,
 *   decision: "APPLY"|"SKIP"|"REVIEW",
 *   reasons: string[],
 *   missing_requirements: string[],
 *   risk_flags: string[]
 * }}
 */
export function evaluateJob(job, profile, { minRelevance = 0.65, preferences = {} } = {}) {
  // Explicit job preferences refine the profile-derived defaults without
  // mutating the candidate record. A preference is intent; it is not a fact
  // that may be used to answer a screening question.
  const scoringProfile = Array.isArray(preferences.locations) && preferences.locations.length
    ? { ...profile, preferredLocations: preferences.locations, applyAnywhereInIndia: Boolean(preferences.applyAnywhereInIndia) }
    : { ...profile, applyAnywhereInIndia: Boolean(preferences.applyAnywhereInIndia) };
  const h = heuristicScore(job, scoringProfile);
  const reasons = [...h.reasons];
  const missing_requirements = [];
  const risk_flags = [];
  const haystack = [job.title, job.company, job.summary, ...(job.tags || [])]
    .filter(Boolean).join(" ").toLowerCase();
  const company = String(job.company || "").trim().toLowerCase();
  const excludedCompany = (preferences.companiesToExclude || [])
    .some((name) => name && company === String(name).trim().toLowerCase());
  const excludedKeyword = (preferences.keywordsToExclude || [])
    .find((word) => word && haystack.includes(String(word).trim().toLowerCase()));
  if (excludedCompany) missing_requirements.push("company is excluded by preference");
  if (excludedKeyword) missing_requirements.push(`excluded keyword: ${excludedKeyword}`);

  const targetTitles = (preferences.jobTitles || []).filter(Boolean);
  if (targetTitles.length) {
    const title = String(job.title || "").toLowerCase();
    const matched = targetTitles.some((wanted) => {
      const normalized = String(wanted).trim().toLowerCase();
      return normalized && (title.includes(normalized) || normalized.includes(title));
    });
    if (!matched) risk_flags.push("title is outside configured targets");
  }
  const includeKeywords = (preferences.keywordsToInclude || []).filter(Boolean);
  if (includeKeywords.length && !includeKeywords.some((word) => haystack.includes(String(word).trim().toLowerCase()))) {
    risk_flags.push("none of the configured required keywords found");
  }

  const years = profile?.totalYears || 0;
  const range = parseExperience(job.experience);
  if (range && years + 0.51 < range.min) {
    missing_requirements.push(`requires ${range.min}+ years; candidate has ${years}`);
    reasons.push("experience gap is too large for automatic apply");
  }

  const title = (job.title || "").toLowerCase();
  if (/\b(senior|staff|principal|lead|manager)\b/.test(title) && years < 4) {
    risk_flags.push("seniority in title vs candidate years");
  }

  let decision = "APPLY";
  if (missing_requirements.length) decision = "SKIP";
  else if (h.score < 0.45) decision = "SKIP";
  else if (h.score < minRelevance || risk_flags.length) decision = "REVIEW";

  return {
    match_score: Math.round(h.score * 100),
    relevance: h.score,
    decision,
    reasons,
    missing_requirements,
    risk_flags,
  };
}

export async function evaluateJobWithModel(job, profile, askJSON, opts) {
  const base = evaluateJob(job, profile, opts);

  // LLM evaluation is additive quality — it's not needed when the heuristic
  // already has a confident answer. Only call the model for REVIEW (uncertain
  // zone between clear APPLY and clear SKIP). This reduces API calls by ~80%
  // and eliminates nearly all 429 rate-limit errors on the free tier.
  if (base.decision === "SKIP" || base.decision === "APPLY") return base;
  if (!askJSON) return base;

  try {
    const res = await askJSON({
      task: "rankJob",
      system:
        "Score one job against one candidate. Be conservative. " +
        "decision must be APPLY, SKIP, or REVIEW. " +
        "SKIP if required years clearly exceed the candidate. " +
        "Never invent candidate skills. Return JSON only.",
      user: JSON.stringify({
        profile: {
          title: profile.currentTitle,
          years: profile.totalYears,
          skills: profile.skills,
          excluded: profile.excludedSkills,
          locations: profile.preferredLocations,
        },
        job: {
          title: job.title,
          experience: job.experience,
          location: job.location,
          tags: job.tags,
          summary: job.summary,
        },
      }),
      schema: {
        type: "object",
        properties: {
          match_score: { type: "number" },
          decision: { type: "string" },
          reasons: { type: "array", items: { type: "string" } },
          missing_requirements: { type: "array", items: { type: "string" } },
          risk_flags: { type: "array", items: { type: "string" } },
        },
        required: ["match_score", "decision", "reasons"],
      },
    });
    // Some models capitalise the field differently — handle both.
    const rawDecision = String(res.decision || res.Decision || "").toUpperCase();
    const decision = ["APPLY", "SKIP", "REVIEW"].includes(rawDecision)
      ? rawDecision
      : base.decision;
    // Never let the model override a heuristic hard-skip on experience.
    const locked = base.decision === "SKIP" && base.missing_requirements.length
      ? "SKIP"
      : decision;
    return {
      match_score: Math.max(0, Math.min(100, Math.round(res.match_score || base.match_score))),
      relevance: Math.max(0, Math.min(1, (res.match_score || base.match_score) / 100)),
      decision: locked,
      reasons: res.reasons?.length ? res.reasons : base.reasons,
      missing_requirements: res.missing_requirements || base.missing_requirements,
      risk_flags: res.risk_flags || base.risk_flags,
    };
  } catch {
    return base;
  }
}
