// Page reader — service-worker side.
//
// Pure module: no DOM, no chrome.* calls.
//
// The agent does not decide what a page is by rules. It shows the page to the
// model — its address, headings, visible text, every interactive element and,
// when one can be taken, a screenshot — and the model says what it is looking
// at: a list of jobs, one job, an application form, a confirmation, a wall.
// The run then acts on that reading.
//
// Rules only ever covered the boards somebody thought of in advance, and got
// even those wrong: a search page is headed with the words the user searched
// for, so a rule that looked for a job's title in the headings found it on the
// list itself and "opened" every job without opening anything.
//
// The model names elements only by the element_N ids it was shown. Anything
// else it returns is dropped here, so the run can never be pointed at a
// control that is not on the page.

export const PAGE_TYPES = [
  "job_list",
  "job_detail",
  "application_form",
  "application_submitted",
  "login_required",
  "blocked",
  "loading",
  "other",
];

// Every property is required and "none" is an empty string or false, so the
// same schema passes OpenAI's strict mode, Gemini and Claude alike.
export const PAGE_SCHEMA = {
  type: "object",
  properties: {
    pageType: { type: "string", enum: PAGE_TYPES },
    summary: { type: "string", description: "One short sentence describing the page, for the user." },
    jobs: {
      type: "array",
      description: "job_list only: every job opening in the list, in page order.",
      items: {
        type: "object",
        properties: {
          target: { type: "string", description: "element_N that opens this job, usually its title link" },
          title: { type: "string" },
          company: { type: "string" },
        },
        required: ["target", "title", "company"],
        additionalProperties: false,
      },
    },
    shownJob: {
      type: "object",
      description: "The job whose details or application this page shows. Empty strings if none.",
      properties: {
        title: { type: "string" },
        company: { type: "string" },
      },
      required: ["title", "company"],
      additionalProperties: false,
    },
    showsRequestedJob: {
      type: "boolean",
      description: "True only if the page shows the details or the application of the job named in Job.",
    },
    alreadyApplied: {
      type: "boolean",
      description: "True if the page says the candidate has already applied to the shown job.",
    },
    applyTarget: {
      type: "string",
      description: "element_N that starts or continues the application for the shown job, or \"\".",
    },
    nextPageTarget: {
      type: "string",
      description: "job_list only: element_N that shows the next page of results, or \"\".",
    },
    towardGoalTarget: {
      type: "string",
      description: "other pages only: element_N that best moves toward the instruction (e.g. a Careers or Jobs link), or \"\".",
    },
    reason: { type: "string", description: "Why you read the page this way." },
  },
  required: [
    "pageType", "summary", "jobs", "shownJob", "showsRequestedJob", "alreadyApplied",
    "applyTarget", "nextPageTarget", "towardGoalTarget", "reason",
  ],
  additionalProperties: false,
};

export const DEFAULT_INSTRUCTION = "Apply to the jobs on this page that match my profile.";

const MAX_JOBS = 60;

function buildSystemPrompt() {
  return [
    "You are the eyes of a browser agent that works on web pages for a job candidate.",
    "You are shown ONE page: its address, headings, visible text, the interactive",
    "elements on it (each with an element_N id), and usually a screenshot.",
    "Say what kind of page it is and which elements matter. You do not act;",
    "the agent acts on what you report, so be exact.",
    "",
    "Page types:",
    "- job_list: lists several job openings (search results, a careers page listing",
    "  openings). It may also show one job's details beside the list.",
    "- job_detail: one job posting, with or without a way to apply.",
    "- application_form: an application in progress — fields, questions, a resume",
    "  upload, a chat asking application questions, or one step of a multi-step form.",
    "- application_submitted: the page confirms that an application was just sent.",
    "- login_required: the user must sign in or register to go on.",
    "- blocked: a CAPTCHA, robot check, or access-denied page.",
    "- loading: the page has not finished loading (skeletons, spinners, empty body).",
    "- other: anything else.",
    "",
    "Rules:",
    "1. Refer to elements ONLY by the element_N ids you were shown. Use \"\" for none.",
    "2. jobs: on a job_list, every job opening in the list, in page order, with the",
    "   element that opens it (usually the title link) and its title and company as",
    "   shown. Never list navigation, filters, ads, promotions, or pagination.",
    "   A job page's rail of similar or recommended jobs is not a list: that page is",
    "   a job_detail and jobs is empty.",
    "3. applyTarget: the control that starts or continues the application for the",
    "   job this page shows — 'Apply', 'Easy Apply', 'Apply on company site',",
    "   'I'm interested', 'Continue'. Never a promotion, an upsell, a control that",
    "   belongs to a different job, or a control that submits a form not yet filled.",
    "4. When Job names the job the agent is working on, showsRequestedJob is true",
    "   only if the page shows THAT job's details or application. Its card sitting",
    "   in a list does not count. The words of a search in the page title or",
    "   headings do not count.",
    "5. alreadyApplied: the page says the candidate already applied to the shown",
    "   job (for example its apply button now reads 'Applied').",
    "6. application_submitted needs an explicit confirmation on the page. A dialog",
    "   opening or a step advancing is an application_form, not a submission.",
    "7. A page still drawing its content is loading, even if a header is visible.",
    "8. towardGoalTarget: only on an 'other' page, the element that best moves",
    "   toward the user's instruction, such as a Careers or Jobs link.",
    "",
    "Return ONLY JSON matching the schema.",
  ].join("\n");
}

/**
 * Build the user prompt for one page reading.
 *
 * @param {object} view      Page view from the content script
 * @param {object} [ctx]
 * @param {string} [ctx.instruction]  What the user told the agent to do
 * @param {object} [ctx.job]          { title, company } the agent is working on
 * @param {string} [ctx.lastStep]     What the agent just did, and what happened
 * @param {boolean} [ctx.screenshot]  Whether a screenshot is attached
 */
export function buildPagePrompt(view, ctx = {}) {
  const parts = [
    "Instruction from the user:",
    String(ctx.instruction || DEFAULT_INSTRUCTION).slice(0, 1000),
  ];
  if (ctx.job?.title) {
    parts.push("", "Job (the job the agent is working on now):",
      JSON.stringify({ title: ctx.job.title, company: ctx.job.company || "" }));
  }
  if (ctx.lastStep) {
    parts.push("", "What the agent just did:", String(ctx.lastStep).slice(0, 500));
  }
  if (ctx.screenshot) {
    parts.push("", "A screenshot of the visible part of the page is attached.");
  }
  parts.push("", "Page:", JSON.stringify(compactView(view)), "", "Read this page. Return JSON only.");
  return parts.join("\n");
}

/** The page view as the model sees it: short fields, nothing it does not need. */
export function compactView(view = {}) {
  return {
    url: view.url || "",
    title: view.title || "",
    headings: (view.headings || []).slice(0, 15),
    dialogOpen: Boolean(view.dialogOpen),
    formFields: view.fieldCount || 0,
    text: String(view.text || "").slice(0, 3000),
    elements: (view.elements || []).map((el) => {
      const out = { id: el.id, tag: el.tag };
      if (el.role && el.role !== el.tag) out.role = el.role;
      if (el.type) out.type = el.type;
      if (el.text) out.text = String(el.text).slice(0, 80);
      if (el.href) out.href = el.href;
      if (el.disabled) out.disabled = true;
      if (el.y != null) out.y = el.y;
      return out;
    }),
  };
}

/**
 * Check a raw reading against the page it describes.
 *
 * Every element id must be one the page actually showed. A reading that
 * names something else loses that field rather than steering the run.
 *
 * @param {*} raw
 * @param {object} view
 * @returns {object} reading
 */
export function validateReading(raw, view = {}) {
  const ids = new Set((view.elements || []).map((el) => el.id));
  const known = (id) => (typeof id === "string" && ids.has(id.trim()) ? id.trim() : "");
  const text = (s, max = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  const r = raw && typeof raw === "object" ? raw : {};
  const pageType = PAGE_TYPES.includes(r.pageType) ? r.pageType : "other";

  const seen = new Set();
  const jobs = [];
  if (pageType === "job_list" && Array.isArray(r.jobs)) {
    for (const job of r.jobs) {
      const target = known(job?.target);
      const title = text(job?.title, 160);
      if (!target || !title || seen.has(target)) continue;
      seen.add(target);
      jobs.push({ target, title, company: text(job?.company, 80) });
      if (jobs.length >= MAX_JOBS) break;
    }
  }

  return {
    pageType,
    summary: text(r.summary) || pageType.replace(/_/g, " "),
    jobs,
    shownJob: { title: text(r.shownJob?.title, 160), company: text(r.shownJob?.company, 80) },
    showsRequestedJob: r.showsRequestedJob === true,
    alreadyApplied: r.alreadyApplied === true,
    applyTarget: known(r.applyTarget),
    nextPageTarget: pageType === "job_list" ? known(r.nextPageTarget) : "",
    towardGoalTarget: pageType === "other" ? known(r.towardGoalTarget) : "",
    reason: text(r.reason, 500),
  };
}

/**
 * Show the page to the model and return its validated reading.
 *
 * @param {object}   view      Page view from the content script
 * @param {object}   ctx       See buildPagePrompt
 * @param {Function} askJSON   The LLM router's askJSON
 * @param {object}   [opts]
 * @param {object}   [opts.screenshot]  { mime, b64 } of the viewport
 * @returns {Promise<object>} reading
 */
export async function readPage(view, ctx, askJSON, opts = {}) {
  const raw = await askJSON({
    task: "pageRead",
    system: buildSystemPrompt(),
    user: buildPagePrompt(view, { ...ctx, screenshot: Boolean(opts.screenshot) }),
    schema: PAGE_SCHEMA,
    file: opts.screenshot || undefined,
  });
  return validateReading(raw, view);
}
