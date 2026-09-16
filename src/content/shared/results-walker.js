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
        // The whole card (experience, location, skills, summary), so the
        // job can be checked against the candidate's profile before opening.
        text: obs().innerText(card).slice(0, 2000),
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

  /**
   * Best-effort company name: the first line of the card after the title.
   * Uses the raw innerText, whose line breaks separate the card's fields.
   */
  function companyFor(card, title) {
    const text = String(card?.innerText || card?.textContent || "");
    if (!text) return "";
    return text.replace(title, "\n").split(/[·|•\n]/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .find(Boolean)?.slice(0, 80) || "";
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

    globalThis.__autoApplyCursor?.setNote(`Opening "${job.title.slice(0, 50)}"`);

    // A job link that opens in a new tab is opened through the worker. To
    // Chrome, a scripted click on a target=_blank link is a pop-up, blocked
    // once the user's last real click on the page is a few seconds old — so
    // only the first job or two of a run would ever open.
    if (target === job.link && /^_blank$/i.test(job.link.getAttribute?.("target") || "")) {
      const tab = await openInNewTab(job.link, job.url);
      if (tab) return { opened: true, newTab: tab };
    }

    const id = obs().registerElement(target, obs().describe(target));
    const result = await exec.click(id, { settleMax: opts.settleMax ?? 3000 });

    // Many boards open the job detail in a new tab. This page will not
    // change, so waiting for `opened()` here would only burn the timeout.
    if (result.openedTab) {
      return { opened: true, newTab: result.openedTab, clickResult: result };
    }

    // The click may be CONFIRMED while the detail has not rendered yet.
    const deadline = Date.now() + (opts.openWaitMs ?? 4000);
    while (Date.now() < deadline) {
      if (opened()) return { opened: true, clickResult: result };
      await new Promise((r) => setTimeout(r, 150));
    }

    // Nothing opened. A board that opens jobs from a click handler hits the
    // same pop-up block, so fall back to opening the job's own URL.
    if (result.result !== core().ACTION_RESULT.CONFIRMED && job.url) {
      const tab = await openInNewTab(target, job.url);
      if (tab) return { opened: true, newTab: tab, clickResult: result };
    }

    return {
      opened: false,
      reason: `clicked "${job.title.slice(0, 60)}" but the job detail did not appear`,
      clickResult: result,
    };
  }

  /**
   * Ask the worker to open `url` in a new tab beside this one. The cursor
   * still travels to the link, so the user sees which job is being opened.
   * @returns {Promise<{id, url}|null>}
   */
  async function openInNewTab(el, url) {
    try {
      await globalThis.__autoApplyPointer?.scrollIntoView(el);
      const r = el.getBoundingClientRect();
      await globalThis.__autoApplyCursor?.moveTo(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      globalThis.__autoApplyCursor?.flashClick();
    } catch (_) { /* cosmetic only */ }

    try {
      const res = await chrome.runtime.sendMessage({ type: "OPEN_TAB_FROM_PAGE", url });
      return res?.ok && res.tab?.id ? res.tab : null;
    } catch (_) {
      return null;
    }
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
