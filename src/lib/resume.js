// Resume ingestion: the user uploads once, everything downstream reads the
// structured profile this produces.

import { get, set } from "./storage.js";
import { askJSON } from "./llm/index.js";

const RESUME_KEY = "resumeFile";     // { name, mime, b64 }
const PROFILE_KEY = "profile";

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    fullName: { type: "string" },
    headline: { type: "string", description: "One line; some job boards expect 50+ characters" },
    location: { type: "string" },
    preferredLocations: { type: "array", items: { type: "string" } },
    totalYears: { type: "number" },
    currentTitle: { type: "string" },
    skills: {
      type: "array",
      description: "Every technical skill, with years of hands-on use",
      items: {
        type: "object",
        properties: { name: { type: "string" }, years: { type: "number" } },
        required: ["name", "years"],
      },
    },
    education: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    noticePeriodDays: { type: "number" },
    currentSalary: { type: "string" },
    salaryExpectation: { type: "string" },
    workAuthorization: { type: "string" },
    visaSponsorship: { type: "string" },
    willingToRelocate: { type: "boolean" },
    remotePreference: { type: "string" },
    projects: { type: "array", items: { type: "string" } },
    certifications: { type: "array", items: { type: "string" } },
    languages: { type: "array", items: { type: "string" } },
    links: {
      type: "object",
      properties: {
        linkedin: { type: "string" },
        github: { type: "string" },
        portfolio: { type: "string" },
      },
    },
  },
  required: ["fullName", "headline", "location", "totalYears", "currentTitle", "skills"],
};

/** Read a File into the {name, mime, b64} shape. Side-panel context only. */
export async function encodeFile(file) {
  const b64 = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  return { name: file.name, mime: file.type, b64, bytes: file.size };
}

/**
 * Store an already-encoded resume.
 * NOTE: a File/Blob cannot cross chrome.runtime.sendMessage - it is not
 * structured-cloneable. The side panel must call encodeFile() first and send
 * the plain object, or simply import this module and call storeResume directly.
 */
export async function storeResume(encoded) {
  const { name, mime, b64 } = encoded;
  if (!b64) throw new Error("storeResume expects an encoded file - call encodeFile() first");
  await set(RESUME_KEY, { name, mime, b64 });
  return { name, bytes: encoded.bytes };
}

export const getResume = () => get(RESUME_KEY, null);

/**
 * Parse the stored resume into a structured profile. Runs once; the result is
 * what fills every application field from then on.
 */
export async function parseResume() {
  const file = await getResume();
  if (!file) throw new Error("no resume uploaded");

  const isText = /^text\//.test(file.mime) || /\.txt$/i.test(file.name || "");
  let resumeBody = "";
  if (isText) {
    resumeBody = atob(file.b64);
    await set("resumeText", resumeBody);
  }

  const profile = await askJSON({
    task: "parseResume",
    file: isText ? undefined : { mime: file.mime, b64: file.b64 },
    system:
      "You extract a structured candidate profile from a resume. Record only " +
      "what the resume actually states. Never inflate years of experience and " +
      "never invent a skill that does not appear. If years for a skill are not " +
      "stated, infer them from the employment dates that mention it, and if " +
      "that is not possible either, use 0. Leave unknown optional fields empty.",
    user: isText
      ? ("Extract the candidate profile from this resume text. The headline " +
         "must exceed 50 characters.\n\n" + resumeBody.slice(0, 24000))
      : "Extract the candidate profile from the attached resume. The headline " +
        "must exceed 50 characters and read as a professional summary line.",
    schema: PROFILE_SCHEMA,
  });

  const check = validateProfile(profile);
  profile._validation = check;

  await set(PROFILE_KEY, profile);

  // Stored either way so the panel can show what went wrong, but a profile
  // that fails the gate must not drive an application.
  if (!check.ok) {
    throw new Error(
      "parsed profile failed validation - is this actually a resume? " +
      check.problems.join("; ")
    );
  }
  return profile;
}

export const getProfile = () => get(PROFILE_KEY, null);

/**
 * Set the profile directly, bypassing PDF parsing.
 *
 * Needed more often than it sounds: plenty of people have real professional
 * experience that their current resume does not document (students working
 * part-time, freelancers, anyone whose CV is out of date). Parsing such a
 * resume yields an empty skill list, and the honest answer to every screening
 * question then becomes 0. Entering the facts directly is the correct fix -
 * inflating the parse would not be.
 *
 * Runs the same validation gate as parseResume(), so nothing downstream can
 * tell the difference.
 */
export async function setProfile(profile) {
  const check = validateProfile(profile);
  const stored = { ...profile, _validation: check, _source: "manual" };
  await set(PROFILE_KEY, stored);
  if (!check.ok) throw new Error("profile incomplete: " + check.problems.join("; "));
  return stored;
}

/**
 * Sanity-gate a parsed profile before it is ever allowed to fill a real
 * application. A model handed a non-resume PDF will still return
 * schema-valid JSON - the schema proves the shape, not that the content is a
 * real person's resume. Without this gate, uploading the wrong file types
 * invented experience into a live employer's form under the user's name.
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
export function validateProfile(p) {
  const problems = [];
  if (!p) return { ok: false, problems: ["no profile"] };

  if (!p.fullName || p.fullName.trim().split(/\s+/).length > 6) {
    problems.push("fullName does not look like a person's name");
  }
  if (!Array.isArray(p.skills) || p.skills.length < 2) {
    problems.push("fewer than 2 skills - a resume should list several");
  }
  if (!p.currentTitle) problems.push("no current title");
  if (typeof p.totalYears !== "number" || p.totalYears < 0 || p.totalYears > 60) {
    problems.push("totalYears is missing or implausible");
  }
  // A short headline is not a reason to refuse to apply anywhere. Some boards
  // impose their own minimum and will say so themselves; the agent reports
  // that when it happens rather than blocking every site for it.
  const warnings = [];
  if (!p.headline || p.headline.length < 50) {
    warnings.push("a headline of 50+ characters is expected by some job boards");
  }
  return { ok: problems.length === 0, problems, warnings };
}
