// Takeover — the page's half of a run: eyes and hands.
//
// The run itself lives in the worker (src/lib/takeover-driver.js), so a page
// that navigates no longer ends it. This script only answers for the page it
// is in:
//
//   PAGE_VIEW          describe this page — address, headings, text, every
//                      interactive element — for the model to read
//   PAGE_ACT           perform one action on an element the model named
//   JOB_LINKS          for the jobs the model found, where each one leads
//   FILL_APPLICATION   fill the application open on this page
//   VERIFY_SUBMITTED   does this page itself confirm a submission?
//
// Nothing here decides what a page is. An earlier version did, by rules —
// whether a job's title was in the headings, whether links repeated like a
// list — and on a search page, whose headings are the job titles, those rules
// "opened" jobs that never opened.

(function () {
  if (globalThis.__autoApplyTakeover) return; // idempotent guard

  const obs = () => globalThis.__autoApplyObserverCore;
  const core = () => globalThis.__autoApplyInteractionCore;
  const loop = () => globalThis.__autoApplyAgentLoopCore;
  const cursor = () => globalThis.__autoApplyCursor;
  const adapter = () => globalThis.genericAgentLoop?.adapter || null;

  /**
   * Is this document the page itself, rather than a frame embedded in it?
   *
   * Every frame in a tab runs these scripts, so every frame sees every message
   * sent to that tab and the first reply wins. A message meant for one
   * particular frame is sent to that frame and marked `toFrame`; everything
   * else belongs to the page. Without this, an embedded ad could answer
   * "describe this page" before the page did.
   */
  const isTopFrame = (() => {
    try { return window.top === window.self; } catch (_) { return false; }
  })();

  /** Elements shown to the model per page. A page with more shows the ones in view. */
  const VIEW_LIMIT = 200;

  function showCursor() {
    try { if (cursor()?.isEnabled()) cursor().show(); } catch (_) { /* cosmetic */ }
  }

  // -------------------------------------------------------------------------
  // Describing the page
  // -------------------------------------------------------------------------

  /**
   * Wait until the page stops changing, so a page still drawing itself is
   * not described half-built. Bounded: some pages never stop.
   */
  function settle(maxMs = 3000, quietMs = 500) {
    if (typeof MutationObserver !== "function" || !document.body) return Promise.resolve();
    return new Promise((resolve) => {
      let quiet = null;
      let cap = null;
      const observer = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(finish, quietMs);
      });
      function finish() {
        observer.disconnect();
        clearTimeout(quiet);
        clearTimeout(cap);
        resolve();
      }
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      quiet = setTimeout(finish, quietMs);
      cap = setTimeout(finish, maxMs);
    });
  }

  function pageView() {
    const a = adapter();
    const gate = a ? loop().securityGate(a) : { blocked: false };
    const snapshot = obs().buildSnapshot({ root: document.body, limit: 1000, platform: "generic" });

    return {
      url: location.href,
      title: document.title,
      headings: headings(),
      text: obs().visibleBodyText(3000),
      elements: forView(snapshot.elements).map(viewElement),
      fieldCount: countFields(),
      dialogOpen: obs().modalOpen(),
      blocked: gate.blocked ? gate.reason : null,
    };
  }

  function headings() {
    return [...document.querySelectorAll("h1, h2, h3, [role='heading']")]
      .filter(obs().isVisible)
      .map((h) => obs().innerText(h).slice(0, 120))
      .filter(Boolean)
      .slice(0, 15);
  }

  function scrollTop() {
    return Math.round(globalThis.scrollY || 0);
  }

  /**
   * Choose which elements the model sees when a page has too many to show.
   * Everything is kept in page order; only the budget decides, and it
   * favours what is on screen and what has a name.
   */
  function forView(elements) {
    if (elements.length <= VIEW_LIMIT) return elements;
    const top = scrollTop();
    const screen = globalThis.innerHeight || 800;
    const scored = elements.map((el, index) => {
      const y = (el.rect?.y || 0) + top;
      let score = 0;
      if (y >= top - screen && y <= top + screen * 3) score += 2;
      if (core().accessibleName(el).length >= 6) score += 1;
      if (["input", "textarea", "select"].includes(el.tag)) score += 1;
      if (el.disabled) score -= 1;
      return { el, index, score };
    });
    scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    return scored.slice(0, VIEW_LIMIT).sort((a, b) => a.index - b.index).map((s) => s.el);
  }

  function viewElement(el) {
    const out = {
      id: el.id,
      tag: el.tag,
      role: el.role,
      text: core().accessibleName(el).slice(0, 80),
      y: Math.round((el.rect?.y || 0) + scrollTop()),
    };
    if (el.type) out.type = el.type;
    if (el.disabled) out.disabled = true;
    const href = shortHref(linkOf(obs().getRawElement(el.id)));
    if (href) out.href = href;
    return out;
  }

  /** The link an element is, or sits inside. */
  function linkOf(el) {
    if (!el) return null;
    return el.closest?.("a[href]") || null;
  }

  function absoluteHref(anchor) {
    if (!anchor) return "";
    try {
      const url = new URL(anchor.getAttribute("href"), location.href);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  /** A link's address, short: the path on this site, or host and path elsewhere. */
  function shortHref(anchor) {
    const href = absoluteHref(anchor);
    if (!href) return "";
    const url = new URL(href);
    const where = url.hostname === location.hostname ? "" : url.host;
    return (where + url.pathname + url.search).slice(0, 120);
  }

  const FIELD_SELECTOR = [
    "input:not([type='hidden']):not([type='submit']):not([type='button'])",
    "textarea", "select", "[contenteditable='true']",
    "[role='textbox']", "[role='radio']", "[role='checkbox']", "[role='combobox']",
  ].join(", ");

  function countFields() {
    return [...document.querySelectorAll(FIELD_SELECTOR)].filter(obs().isVisible).length;
  }

  // -------------------------------------------------------------------------
  // Jobs the model found
  // -------------------------------------------------------------------------

  /** Query parameters that identify a job, rather than track a click. */
  const JOB_ID_PARAM = /^(?:jk|vjk|gh_jid|jobId|job_id|jobListingId|currentJobId|posting|requisitionId)$/i;

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
   * For each job element the model named: where it leads, whether it opens a
   * new tab, and the text of its card — the part of the list that belongs to
   * this job and no other — for checking the job against the profile.
   */
  function jobLinks(targets) {
    const found = (targets || []).map((target) => [target, obs().resolveLive(target).el || null]);
    const all = found.map(([, el]) => el).filter(Boolean);

    return found.map(([target, el]) => {
      if (!el) return { target };
      const anchor = linkOf(el) || el.querySelector?.("a[href]") || null;
      const url = absoluteHref(anchor);
      return {
        target,
        url,
        key: url ? canonicalJobUrl(url) : "",
        newTab: /^_blank$/i.test(anchor?.getAttribute("target") || ""),
        text: obs().innerText(cardOf(el, all)).slice(0, 2000),
      };
    });
  }

  /** The largest ancestor of `el` that holds no other job: its card. */
  function cardOf(el, all) {
    let card = el;
    while (card.parentElement && card.parentElement !== document.body &&
           !all.some((other) => other !== el && card.parentElement.contains(other))) {
      card = card.parentElement;
    }
    return card;
  }

  /** Show the user which job is being opened before the worker opens it. */
  async function pointAt(target) {
    const el = obs().resolveLive(target).el;
    if (!el) return;
    try {
      await globalThis.__autoApplyPointer?.scrollIntoView(el);
      const r = el.getBoundingClientRect();
      await cursor()?.moveTo(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      cursor()?.flashClick();
    } catch (_) { /* cosmetic only */ }
  }

  // -------------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------------

  /** @param {object} [opts] `settleMax`: how long a click waits for the page to react */
  async function act(action, { settleMax = 3000 } = {}) {
    showCursor();
    let r;
    try {
      r = await loop().dispatch(action, { settleMax, getResume: async () => null });
    } catch (err) {
      return { result: core().ACTION_RESULT.FAILED, error: String(err?.message || err) };
    }
    return {
      result: r.result,
      success: Boolean(r.success),
      openedTab: r.openedTab || null,
      error: r.error || null,
    };
  }

  /**
   * Fill the application on this page with the shared agent loop.
   *
   * A page with no field at all but a frame is reported as such, so the
   * worker can look for the application inside the frame first.
   */
  async function fillApplication({ job, instruction, force }) {
    showCursor();
    const a = adapter();
    if (!a) return { submitted: false, reason: "no adapter is available on this page" };
    if (!force && isTopFrame && countFields() === 0 && document.querySelector("iframe")) {
      return { noForm: true };
    }
    return loop().run(a, { maxTurns: 30, job: job || null, instruction: instruction || "" });
  }

  globalThis.__autoApplyTakeover = { pageView, jobLinks, act, fillApplication, canonicalJobUrl, settle };

  // -------------------------------------------------------------------------
  // Messages from the worker and the side panel
  // -------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // The cursor is drawn by each frame in its own document, so every frame
    // acts on this one. Only the page answers, so the panel still gets a
    // single reply.
    if (msg.type === "SET_CURSOR_VISIBLE") {
      cursor()?.setEnabled(msg.visible !== false);
      if (!isTopFrame) return false;
      sendResponse({ ok: true });
      return false;
    }

    if (Boolean(msg.toFrame) === isTopFrame) return false;

    const reply = (promise) => {
      Promise.resolve(promise)
        .then((r) => sendResponse(r))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    };

    switch (msg.type) {
      case "PAGE_VIEW":
        showCursor();
        return reply(settle().then(() => ({ ok: true, view: pageView() })));

      case "PAGE_ACT":
        return reply(act(msg.action || {}));

      case "JOB_LINKS":
        sendResponse({ ok: true, links: jobLinks(msg.targets) });
        return false;

      case "POINT_AT":
        return reply(pointAt(msg.target).then(() => ({ ok: true })));

      case "FILL_APPLICATION":
        return reply(fillApplication(msg));

      case "VERIFY_SUBMITTED":
        sendResponse({ ok: true, submitted: Boolean(adapter()?.isComplete()) });
        return false;

      case "CURSOR_NOTE":
        if (msg.note) cursor()?.setNote(msg.note);
        else cursor()?.clearNote();
        sendResponse({ ok: true });
        return false;

      case "TAKEOVER_PROBE":
        // The panel checks the agent can run here before offering Take over.
        sendResponse({ ok: true, url: location.href, title: document.title });
        return false;

      default:
        return false;
    }
  });
}());
