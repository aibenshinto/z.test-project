// Results-page walker.
//
// This is the piece that makes the agent work the way a person does: you are
// already signed in, you have already run the search you want, and the agent
// takes over the page in front of you and works down the visible results.
//
// It deliberately does NOT use the stored job queue or open its own background
// tabs. The page the user is looking at is the source of truth.
//
// Job cards are found semantically — a link to a job detail URL, grouped by
// its surrounding card — so this works on Naukri, LinkedIn and most listing
// pages without per-site selectors. Platform adapters may supply a hint.

(function () {
  if (globalThis.__autoApplyResultsWalker) return; // idempotent guard

  const obs = () => globalThis.__autoApplyObserverCore;
  const core = () => globalThis.__autoApplyInteractionCore;

  // -------------------------------------------------------------------------
  // Job-card discovery
  // -------------------------------------------------------------------------

  // URL shapes that indicate "this link opens a specific job".
  const JOB_URL_PATTERNS = [
    /\/jobs?\/view\//i,          // linkedin.com/jobs/view/123
    /\/job-listings-/i,          // naukri.com/job-listings-title-company
    /\/jobs?\/[^/]+-\d{4,}/i,    // generic slug-with-id
    /\/viewjob\b/i,              // indeed
    /[?&](?:jk|jobId|job_id|currentJobId)=/i,
  ];

  function looksLikeJobLink(href) {
    if (!href) return false;
    return JOB_URL_PATTERNS.some((re) => re.test(href));
  }

  /**
   * Walk up from a link to the element that represents the whole card, so the
   * agent can read the title/company together and click the card if the link
   * itself is not the interactive part.
   */
  function cardFor(link) {
    let node = link;
    for (let depth = 0; depth < 6 && node?.parentElement; depth++) {
      node = node.parentElement;
      const role = node.getAttribute?.("role");
      if (role === "listitem" || node.tagName === "LI" || node.tagName === "ARTICLE") return node;
      const cls = String(node.className || "");
      if (/card|job-tuple|jobTuple|result|listing|srp-jobtuple/i.test(cls)) return node;
    }
    return link.closest?.("li, article") || link;
  }

  /**
   * Find the job results visible on the current page.
   *
   * @param {object} [opts]
   * @param {Function} [opts.hint]  Platform-supplied card selector function
   * @returns {Array<{id, url, title, company, element, rect}>}
   */
  function findJobs(opts = {}) {
    const seenUrls = new Set();
    const jobs = [];

    const hinted = (() => {
      try { return opts.hint?.() || []; } catch (_) { return []; }
    })();

    const links = hinted.length
      ? hinted
      : [...document.querySelectorAll("a[href]")].filter((a) => looksLikeJobLink(a.getAttribute("href")));

    for (const link of links) {
      if (!obs().isVisible(link)) continue;

      const href = link.href || link.getAttribute("href");
      if (!href) continue;

      // One entry per job, even when a card links to it several times.
      const key = canonicalJobUrl(href);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);

      const card = cardFor(link);
      const title = obs().innerText(link).slice(0, 160) ||
        obs().innerText(card).split("\n")[0].slice(0, 160);
      if (!title) continue;

      jobs.push({
        id: key,
        url: href,
        title,
        company: companyFor(card, title),
        element: card,
        link,
        rect: obs().rectOf(card),
      });
    }

    // Present them in the order the user sees them.
    jobs.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    return jobs;
  }

  /** Strip tracking parameters so the same job is not visited twice. */
  function canonicalJobUrl(href) {
    try {
      const url = new URL(href, location.href);
      for (const param of [...url.searchParams.keys()]) {
        if (!/^(?:jk|jobId|job_id|currentJobId)$/i.test(param)) url.searchParams.delete(param);
      }
      url.hash = "";
      return url.href;
    } catch (_) {
      return String(href);
    }
  }

  /** Best-effort company name from the card text, excluding the title itself. */
  function companyFor(card, title) {
    const text = obs().innerText(card);
    if (!text) return "";
    const rest = text.replace(title, " ").replace(/\s+/g, " ").trim();
    return rest.split(/[·|•\n]/)[0].trim().slice(0, 80);
  }

  // -------------------------------------------------------------------------
  // Opening a job
  // -------------------------------------------------------------------------

  /**
   * Open one job from the results list, by clicking its card the way a user
   * would rather than navigating directly.
   *
   * Clicking matters: on LinkedIn the detail pane loads in place, and a direct
   * navigation would lose the results list the walker is working through.
   *
   * @param {object} job          An entry from findJobs()
   * @param {Function} opened     Returns true once the job detail is showing
   * @returns {Promise<object>}
   */
  async function openJob(job, opened, opts = {}) {
    const exec = globalThis.__autoApplyExecutorCore;

    const target = job.link?.isConnected ? job.link : job.element;
    if (!target?.isConnected) {
      return { opened: false, reason: "the job card is no longer on the page" };
    }

    const id = obs().registerElement(target, obs().describe(target));
    globalThis.__autoApplyCursor?.setNote(`Opening "${job.title.slice(0, 50)}"`);

    const result = await exec.click(id, { settleMax: opts.settleMax ?? 3000 });

    // The click may be CONFIRMED while the detail has not rendered yet.
    const deadline = Date.now() + (opts.openWaitMs ?? 4000);
    while (Date.now() < deadline) {
      if (opened()) return { opened: true, clickResult: result };
      await new Promise((r) => setTimeout(r, 150));
    }

    return {
      opened: false,
      reason: `clicked "${job.title.slice(0, 60)}" but the job detail did not appear`,
      clickResult: result,
    };
  }

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  /** Find a "next page" control, if the results are paginated. */
  function findNextPage() {
    const candidates = [...document.querySelectorAll("a, button, [role='button']")]
      .filter((el) => obs().isVisible(el) && !el.disabled);

    for (const el of candidates) {
      const name = core().accessibleName(obs().describe(el));
      if (/^(?:next|next page|›|»)$/i.test(name.trim())) return el;
      if (/\bnext page\b/i.test(name)) return el;
    }
    return null;
  }

  /**
   * Advance to the next page of results, verifying the list actually changed.
   * @returns {Promise<boolean>}
   */
  async function goToNextPage() {
    const next = findNextPage();
    if (!next) return false;

    const exec = globalThis.__autoApplyExecutorCore;
    const id = obs().registerElement(next, obs().describe(next));
    globalThis.__autoApplyCursor?.setNote("Next page of results");

    const result = await exec.click(id, { settleMax: 4000 });
    return result.result === core().ACTION_RESULT.CONFIRMED;
  }

  globalThis.__autoApplyResultsWalker = {
    findJobs, openJob, findNextPage, goToNextPage,
    canonicalJobUrl, looksLikeJobLink, cardFor,
  };
}());
