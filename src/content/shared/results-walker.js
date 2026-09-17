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
// its surrounding card — so this works on any board and most listing
// pages without per-site selectors. Platform adapters may supply a hint.

(function () {
  if (globalThis.__autoApplyResultsWalker) return; // idempotent guard

  const obs = () => globalThis.__autoApplyObserverCore;
  const core = () => globalThis.__autoApplyInteractionCore;

  // -------------------------------------------------------------------------
  // Job-card discovery
  // -------------------------------------------------------------------------

  // URL shapes that say "this link opens one particular job". These are a
  // fast path for the boards whose shapes are already known — never the whole
  // answer, because the board a user wants is always the one nobody listed.
  const JOB_URL_PATTERNS = [
    /\/jobs?\/view\//i,          // linkedin.com/jobs/view/123
    /\/job-listings-/i,          // naukri.com/job-listings-title-company
    /\/jobs?\/[^/]+-\d{4,}/i,    // generic slug-with-id
    /\/jobs?\/\d{3,}/i,          // greenhouse.io/acme/jobs/4012345
    /\/viewjob\b/i,              // indeed
    /[?&](?:jk|vjk|gh_jid|jobId|job_id|jobListingId|currentJobId|posting)=/i,
  ];

  /** Query parameters that identify a job, rather than track a click. */
  const JOB_ID_PARAM = /^(?:jk|vjk|gh_jid|jobId|job_id|jobListingId|currentJobId|posting|requisitionId)$/i;

  /** How many same-shaped links make a list rather than a coincidence. */
  const MIN_REPEATED = 3;

  function looksLikeJobLink(href) {
    if (!href) return false;
    return JOB_URL_PATTERNS.some((re) => re.test(href));
  }

  /**
   * What kind of page a URL points at, with the parts that identify one
   * particular job blanked out. Two links of the same shape are two of the
   * same kind of thing.
   */
  function urlShape(href) {
    let url;
    try { url = new URL(href, location.href); } catch (_) { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;

    const path = url.pathname.split("/")
      .map((segment) => (/\d{3,}/.test(segment) || /^[0-9a-f][0-9a-f-]{15,}$/i.test(segment) ? "#" : segment))
      .join("/");
    return `${url.host}${path}?${[...url.searchParams.keys()].sort().join(",")}`;
  }

  /** A link with a name of its own — not a chevron, an icon or a page number. */
  function namesSomething(link) {
    return obs().innerText(link).trim().length >= 6;
  }

  /**
   * The largest group of links that point at the same kind of page, when
   * those links stack up like a list.
   *
   * A board this agent has never seen still lists its jobs the way every
   * other one does: one link per job, all the same shape, stacked down the
   * page. That is a far better signal than a list of URL patterns, which can
   * only ever cover the boards somebody thought of in advance — Greenhouse,
   * Lever, Workday and Glassdoor all missed the old list, and on those the
   * agent found no jobs at all and treated the whole search page as one job.
   */
  function repeatedJobLinks(links) {
    const groups = new Map();
    for (const link of links) {
      const shape = urlShape(link.href || link.getAttribute("href"));
      if (!shape || !namesSomething(link)) continue;
      if (!groups.has(shape)) groups.set(shape, new Map());
      const byJob = groups.get(shape);
      const key = canonicalJobUrl(link.href || link.getAttribute("href"));
      if (!byJob.has(key)) byJob.set(key, link);
    }

    let best = [];
    for (const byJob of groups.values()) {
      const group = [...byJob.values()];
      if (group.length > best.length && stacksLikeAList(group)) best = group;
    }
    return best.length >= MIN_REPEATED ? best : [];
  }

  /**
   * Do these links stack down the page, one per row?
   *
   * A row of links sharing a shape is a menu or a breadcrumb; a column of
   * them is a list of results. This is the difference, and it holds whatever
   * language the page is in.
   */
  function stacksLikeAList(links) {
    const rows = new Set();
    for (const link of links) {
      const rect = obs().rectOf(cardFor(link));
      if (rect.width > 0 || rect.height > 0) rows.add(Math.round(rect.y));
    }
    return rows.size >= MIN_REPEATED;
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

    const visible = [...document.querySelectorAll("a[href]")].filter((a) => obs().isVisible(a));

    // Shapes this agent already knows, or whatever this page repeats —
    // whichever finds more. A page can carry one link of a known shape and a
    // whole list of an unknown one.
    let links = hinted;
    if (!links.length) {
      const known = visible.filter((a) => looksLikeJobLink(a.getAttribute("href")));
      const repeated = repeatedJobLinks(visible);
      links = repeated.length > known.length ? repeated : known;
    }

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
        if (!JOB_ID_PARAM.test(param)) url.searchParams.delete(param);
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
  /** How long a page of results is given to replace the one before it. */
  const NEW_RESULTS_MS = 6000;

  async function goToNextPage() {
    const next = findNextPage();
    if (!next) return false;

    const before = new Set(findJobs().map((job) => job.id));
    const exec = globalThis.__autoApplyExecutorCore;
    const id = obs().registerElement(next, obs().describe(next));
    globalThis.__autoApplyCursor?.setNote("Next page of results");

    const result = await exec.click(id, { settleMax: 4000 });
    if (result.result !== core().ACTION_RESULT.CONFIRMED) return false;

    // A click the page acknowledged is not the same as a page of new results:
    // a "Next" in a carousel acknowledges just as loudly, and a pager that
    // quietly did nothing would otherwise have the run walk the same jobs
    // again. The run moves on only when the jobs themselves change.
    const deadline = Date.now() + NEW_RESULTS_MS;
    for (;;) {
      const now = findJobs().map((job) => job.id);
      if (now.length && now.some((id) => !before.has(id))) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  globalThis.__autoApplyResultsWalker = {
    findJobs, openJob, findNextPage, goToNextPage,
    canonicalJobUrl, looksLikeJobLink, cardFor,
  };
}());
