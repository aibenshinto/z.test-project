// Job relevance scoring, 0..1.
//
// Two tiers. The heuristic runs locally on every job with no API call, which
// keeps the common case free and means ranking still works before a key is
// configured. The model pass is optional and only reranks the shortlist.

const EXP_RE = /(\d+)\s*-\s*(\d+)\s*yrs?/i;

/** Parse "0-1 Yrs" -> {min:0,max:1}. */
function parseExperience(s) {
  const m = (s || "").match(EXP_RE);
  return m ? { min: +m[1], max: +m[2] } : null;
}

function norm(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9+#. ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Recency: 1.0 today, decaying to ~0.3 at a month. */
function recencyScore(postedOn) {
  const s = norm(postedOn);
  if (/just now|today|few hours/.test(s)) return 1;
  let m;
  if ((m = s.match(/(\d+)\s*day/)))  return Math.max(0.35, 1 - +m[1] * 0.06);
  if ((m = s.match(/(\d+)\+?\s*week/))) return Math.max(0.3, 1 - +m[1] * 0.2);
  if (/month/.test(s)) return 0.25;
  return 0.6;
}

/**
 * @param {object} job     scraped card
 * @param {object} profile validated profile
 * @returns {{score:number, reasons:string[]}}
 */
export function heuristicScore(job, profile) {
  const reasons = [];
  const haystack = norm([job.title, job.summary, (job.tags || []).join(" ")].join(" "));
  const skills = profile.skills || [];
  const excluded = (profile.excludedSkills || []).map((s) => s.toLowerCase());

  // --- skill overlap, weighted by the years behind each skill ---
  let matched = 0, weight = 0;
  for (const s of skills) {
    if (haystack.includes(norm(s.name))) { matched++; weight += Math.min(s.years, 5); }
  }
  const skillScore = skills.length ? Math.min(1, (matched / skills.length) * 0.7 + Math.min(weight / 6, 1) * 0.3) : 0;
  if (matched) reasons.push(`${matched}/${skills.length} skills matched`);
  else reasons.push("no profile skills in this posting");

  // --- a posting built on a disclaimed skill is a poor fit, not a neutral one ---
  const hitsExcluded = excluded.filter((e) => haystack.includes(e));
  if (hitsExcluded.length) reasons.push(`requires disclaimed: ${hitsExcluded.join(", ")}`);
  const excludedPenalty = hitsExcluded.length * 0.15;

  // --- experience bracket ---
  const range = parseExperience(job.experience);
  const years = profile.totalYears || 0;
  let expScore = 0.5;
  if (range) {
    if (years >= range.min && years <= range.max) { expScore = 1; reasons.push("experience in range"); }
    else if (years < range.min) {
      expScore = Math.max(0, 1 - (range.min - years) * 0.35);
      reasons.push(`under-qualified by ${(range.min - years).toFixed(1)}y`);
    } else {
      // Being over the top of the band is a much softer miss than being under.
      expScore = Math.max(0.4, 1 - (years - range.max) * 0.12);
      reasons.push(`over the band by ${(years - range.max).toFixed(1)}y`);
    }
  }

  // --- location ---
  const prefs = (profile.preferredLocations || []).map(norm);
  const loc = norm(job.location);
  const locHit = prefs.some((p) => p && loc.includes(p)) || /remote/.test(loc);
  const locScore = prefs.length ? (locHit ? 1 : 0.25) : 0.6;
  reasons.push(locHit ? "location preferred" : "location not preferred");

  const rec = recencyScore(job.postedOn);
  if (rec < 0.4) reasons.push("stale posting");

  const score = Math.max(0, Math.min(1,
    skillScore * 0.45 + expScore * 0.25 + locScore * 0.20 + rec * 0.10 - excludedPenalty
  ));

  return { score: +score.toFixed(3), reasons };
}

/**
 * Optional model rerank of the shortlist. Falls back to the heuristic on any
 * failure - ranking must never be the thing that breaks a run.
 */
export async function modelRerank(jobs, profile, askJSON) {
  if (!jobs.length) return jobs;
  try {
    const res = await askJSON({
      task: "rankJob",
      system:
        "You score how well job postings match a candidate. Be strict: a high " +
        "score means the candidate is genuinely competitive, not merely eligible. " +
        "Penalise postings whose core requirement is a skill the candidate lacks.",
      user: JSON.stringify({
        profile: { title: profile.currentTitle, years: profile.totalYears,
                   skills: profile.skills, excluded: profile.excludedSkills },
        jobs: jobs.map((j) => ({ id: j.id, title: j.title, exp: j.experience,
                                 location: j.location, tags: j.tags, summary: j.summary })),
      }),
      schema: {
        type: "object",
        properties: {
          scores: { type: "array", items: {
            type: "object",
            properties: { id: { type: "string" }, score: { type: "number" }, why: { type: "string" } },
            required: ["id", "score", "why"],
          }},
        },
        required: ["scores"],
      },
    });
    const byId = new Map(res.scores.map((s) => [s.id, s]));
    return jobs.map((j) => {
      const s = byId.get(j.id);
      return s ? { ...j, relevance: Math.max(0, Math.min(1, s.score)), why: s.why } : j;
    });
  } catch (e) {
    console.warn("[ranker] model rerank failed, keeping heuristic:", e.message);
    return jobs;
  }
}
