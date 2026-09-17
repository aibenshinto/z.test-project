// Shared UI observation core (content-script side).
//
// One implementation of "what interactive controls is the user looking at?",
// used by the page adapter. Previously each per-site adapter
// carried its own near-identical copy, and each copy filtered buttons through
// a hardcoded job-application word list — which hid legitimate controls such
// as "Start application" or "Get started" from the model.
//
// This core captures interactive elements GENERALLY and lets the model decide
// what matters. Apply-intent ranking is provided as a hint alongside the
// elements, never as a filter that removes them.
//
// It also records, for every element, the metadata needed to re-find that
// element after a React rerender. An element_N ID is a LOGICAL target, not a
// permanent DOM pointer.

(function () {
  if (globalThis.__autoApplyObserverCore) return; // idempotent guard

  // -------------------------------------------------------------------------
  // Text / visibility primitives
  // -------------------------------------------------------------------------

  function innerText(el) {
    return String(el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return false;
    if (Number(s.opacity) === 0) return false;
    return true;
  }

  /** Visible AND inside (or near) the viewport — used for pointer targeting. */
  function isInViewport(el) {
    if (!isVisible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 &&
           r.top < (window.innerHeight || 0) && r.left < (window.innerWidth || 0);
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      width: Math.round(r.width), height: Math.round(r.height),
    };
  }

  // -------------------------------------------------------------------------
  // Element registry — logical targets, not raw pointers
  // -------------------------------------------------------------------------

  /** @type {Map<string, {el: Element, meta: object}>} */
  const registry = new Map();
  let nextId = 1;

  function resetRegistry() {
    registry.clear();
    nextId = 1;
  }

  function registerElement(el, meta) {
    const id = "element_" + nextId++;
    registry.set(id, { el, meta: { ...meta, id } });
    return id;
  }

  /** The metadata recorded for a logical target at observe time. */
  function getMeta(id) {
    return registry.get(id)?.meta || null;
  }

  /** The raw node, whether or not it is still attached. */
  function getRawElement(id) {
    return registry.get(id)?.el || null;
  }

  /** Replace the node behind a logical ID after re-resolution. */
  function rebind(id, el) {
    const entry = registry.get(id);
    if (!entry) return false;
    entry.el = el;
    entry.meta = { ...entry.meta, ...describe(el), id };
    return true;
  }

  /**
   * Drop the cached node for a logical ID while keeping its metadata, so the
   * next resolveLive() searches the live DOM for a fresh match instead of
   * reusing a node we already failed to interact with.
   */
  function rebindStale(id) {
    const entry = registry.get(id);
    if (!entry) return false;
    entry.el = null;
    return true;
  }

  // -------------------------------------------------------------------------
  // Describe one element
  // -------------------------------------------------------------------------

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "combobox", "listbox", "option",
    "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "tab",
    "textbox", "searchbox", "spinbutton", "slider",
  ]);

  /**
   * Produce the metadata record for an element. This is both what the model
   * sees and what we use to re-find the element later, so it must be
   * semantic rather than positional.
   */
  function describe(el) {
    if (!el || el.nodeType !== 1) return {};
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute?.("type") || (tag === "input" ? "text" : "")).toLowerCase();
    const role = el.getAttribute?.("role") || implicitRole(tag, type);
    const disabled = Boolean(
      el.disabled || el.getAttribute?.("aria-disabled") === "true",
    );

    const meta = {
      tag,
      role,
      type: type || undefined,
      text: visibleLabelOf(el),
      ariaLabel: el.getAttribute?.("aria-label") || "",
      title: el.getAttribute?.("title") || "",
      name: el.getAttribute?.("name") || "",
      placeholder: el.getAttribute?.("placeholder") || "",
      visible: isVisible(el),
      enabled: !disabled,
      disabled,
      connected: el.isConnected !== false,
      rect: rectOf(el),
    };

    // Values are useful to the model but must not leak passwords.
    if (type !== "password") {
      if (tag === "select") {
        meta.value = el.value || "";
        meta.selectedText = el.options?.[el.selectedIndex]
          ? innerText(el.options[el.selectedIndex]) : "";
        meta.options = [...(el.options || [])].map((o) => innerText(o)).filter(Boolean).slice(0, 50);
      } else if (tag === "input" || tag === "textarea") {
        meta.value = el.value || "";
      } else if (el.isContentEditable) {
        meta.value = innerText(el).slice(0, 200);
      }
    }

    if (type === "radio" || type === "checkbox" || role === "checkbox" || role === "radio") {
      meta.checked = Boolean(el.checked ?? el.getAttribute?.("aria-checked") === "true");
    }

    return meta;
  }

  function implicitRole(tag, type) {
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "file") return "file";
      return "textbox";
    }
    return "";
  }

  /**
   * The label a sighted user would associate with this control: its own text,
   * an explicit <label for>, a wrapping label, or a nearby legend/heading.
   */
  function visibleLabelOf(el) {
    const own = innerText(el);
    if (own && own.length <= 200) return own;

    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return innerText(lbl);
    }
    const wrapping = el.closest?.("label");
    if (wrapping) return innerText(wrapping);

    const labelledBy = el.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map((refId) => document.getElementById(refId))
        .filter(Boolean).map(innerText).filter(Boolean);
      if (parts.length) return parts.join(" ");
    }

    const group = el.closest?.(
      "fieldset, [role='group'], .form-group, .field, [class*='field'], " +
      "[class*='question'], [class*='form-element'], [class*='form-row']",
    );
    if (group) {
      const lbl = group.querySelector("legend, label, [class*='label']");
      if (lbl && lbl !== el) return innerText(lbl);
    }

    return own.slice(0, 200);
  }

  // -------------------------------------------------------------------------
  // Collect interactive elements
  // -------------------------------------------------------------------------

  const INTERACTIVE_SELECTOR = [
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "[role]",
    "[onclick]",
    "[contenteditable='true']",
    "[tabindex]:not([tabindex='-1'])",
    "[aria-label]",
    "[title]",
  ].join(", ");

  /**
   * Is this element worth showing the model?
   *
   * The old adapters answered this with a job-application keyword list. This
   * asks a general question instead: is it an interactive control a user could
   * act on? Job-specific ranking happens afterwards, as a hint.
   */
  function isMeaningfulControl(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();

    if (type === "hidden" || type === "password") return false;
    if (["button", "a", "input", "textarea", "select"].includes(tag)) return true;

    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
    if (el.isContentEditable) return true;
    if (el.hasAttribute("onclick")) return true;

    // A div with an aria-label or title that is also focusable/clickable —
    // e.g. <div role="button" aria-label="Apply now"> patterns without a role.
    const hasAccessibleName = el.getAttribute("aria-label") || el.getAttribute("title");
    if (hasAccessibleName) {
      const tabindex = el.getAttribute("tabindex");
      if (tabindex && tabindex !== "-1") return true;
      if (getComputedStyle(el).cursor === "pointer") return true;
    }

    return false;
  }

  /**
   * Walk the DOM (including open shadow roots) and collect candidate elements.
   */
  function collectCandidates(root) {
    const out = [];
    const seen = new Set();

    function walk(node, depth) {
      if (depth > 4) return; // bound shadow-root recursion
      let found;
      try {
        found = node.querySelectorAll(INTERACTIVE_SELECTOR);
      } catch (_) {
        return;
      }
      for (const el of found) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      }
      // Shadow hosts that are not themselves interactive
      try {
        for (const host of node.querySelectorAll("*")) {
          if (host.shadowRoot && !seen.has(host)) walk(host.shadowRoot, depth + 1);
        }
      } catch (_) { /* non-fatal */ }
    }

    walk(root, 0);
    return out;
  }

  /**
   * Build the element list for a snapshot.
   *
   * Nothing is dropped for not matching a keyword. Elements are dropped only
   * when they are invisible, duplicated, or not interactive at all. The list
   * is capped so a huge page cannot blow up the prompt — visible, enabled,
   * apply-relevant controls are kept first.
   *
   * @param {Element} root
   * @param {number} [limit=120]
   */
  function collectElements(root, limit = 120) {
    const elements = [];
    const seenRadioGroups = new Set();
    const consumed = new Set();

    for (const el of collectCandidates(root)) {
      if (consumed.has(el)) continue;
      if (!isMeaningfulControl(el)) continue;
      if (!isVisible(el)) continue;

      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();

      // Radio groups collapse to one entry listing every option, so the model
      // picks an option ID rather than guessing among identical siblings.
      if (tag === "input" && type === "radio" && el.name) {
        if (seenRadioGroups.has(el.name)) continue;
        seenRadioGroups.add(el.name);

        const group = [...root.querySelectorAll(
          `input[type='radio'][name="${CSS.escape(el.name)}"]`,
        )].filter(isVisible);
        if (!group.length) continue;

        const options = group.map((radio) => {
          const meta = describe(radio);
          return { id: registerElement(radio, meta), label: meta.text || radio.value || "", checked: Boolean(radio.checked) };
        });
        group.forEach((r) => consumed.add(r));

        const groupMeta = describe(el);
        elements.push({
          id: options[0].id,
          tag: "input",
          role: "radiogroup",
          type: "radio",
          text: groupMeta.text,
          ariaLabel: groupMeta.ariaLabel,
          title: groupMeta.title,
          name: el.name,
          options,
          visible: true,
          enabled: groupMeta.enabled,
          disabled: groupMeta.disabled,
          rect: groupMeta.rect,
        });
        continue;
      }

      const meta = describe(el);

      // A control with no name of any kind and no value is noise.
      const named = meta.text || meta.ariaLabel || meta.title || meta.placeholder || meta.name;
      const isField = ["input", "textarea", "select"].includes(tag);
      if (!named && !isField) continue;

      consumed.add(el);
      const id = registerElement(el, meta);
      elements.push({ id, ...meta, connected: undefined });
    }

    if (elements.length <= limit) return elements;

    // Over budget: keep the elements most likely to matter. Form fields and
    // apply-intent controls outrank incidental navigation links.
    const core = globalThis.__autoApplyInteractionCore;
    const scored = elements.map((el, index) => {
      let priority = 0;
      if (["input", "textarea", "select"].includes(el.tag)) priority += 2;
      if (el.role === "radiogroup") priority += 2;
      if (core) priority += core.rankApplyIntent(el) * 3;
      if (el.tag === "button" || el.role === "button") priority += 1;
      if (el.disabled) priority -= 1;
      return { el, priority, index };
    });
    scored.sort((a, b) => (b.priority - a.priority) || (a.index - b.index));
    return scored.slice(0, limit)
      .sort((a, b) => a.index - b.index)
      .map((s) => s.el);
  }

  /**
   * Describe the visible interactive elements WITHOUT registering them.
   *
   * Diagnostics and any other read-only inspection must use this: calling
   * collectElements would append fresh element_N entries to the registry on
   * every failure, leaking detached nodes and advancing the IDs past those the
   * model was shown.
   *
   * @param {Element} [root]
   * @param {number} [limit=60]
   */
  function describeAll(root = document.body, limit = 60) {
    const out = [];
    for (const el of collectCandidates(root)) {
      if (out.length >= limit) break;
      if (!isMeaningfulControl(el) || !isVisible(el)) continue;
      out.push(describe(el));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Page fingerprint — the basis for before/after comparison
  // -------------------------------------------------------------------------

  /** Cheap, stable hash of a string. Not cryptographic; only for comparison. */
  function hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  function visibleBodyText(maxChars = 4000) {
    return String(document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, maxChars);
  }

  /**
   * Body text with the parts that change on their own removed, for use in the
   * fingerprint only.
   *
   * A job page mutates constantly without any interaction: relative timestamps
   * tick over, notification badges increment, lazy rails paint in. Hashing raw
   * text would let that noise "confirm" a click that did nothing — the precise
   * false-success this system exists to prevent.
   */
  function stableBodyText(maxChars = 4000) {
    return visibleBodyText(maxChars)
      // "3 minutes ago", "2 days ago"
      .replace(/\b\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago\b/gi, "")
      // "· 5m", "· 2h" style relative stamps
      .replace(/\b\d+\s*[smhdw]\s+ago\b/gi, "")
      // Clock times and standalone counters/badges.
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\b/gi, "")
      .replace(/\(\s*\d+\s*\)/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function modalOpen() {
    return [...document.querySelectorAll(
      "[role='dialog'], [aria-modal='true'], dialog[open], .modal, [class*='modal'], [class*='drawer']",
    )].some(isVisible);
  }

  /**
   * A compact description of page state used to answer "did anything happen?".
   *
   * @param {object} [opts]
   * @param {string} [opts.applicationState]
   * @returns {object} fingerprint
   */
  function fingerprint(opts = {}) {
    const fields = [...document.querySelectorAll("input, textarea, select")].filter(isVisible);
    const controls = [...document.querySelectorAll("button, [role='button'], a[href]")].filter(isVisible);
    const errors = [...document.querySelectorAll(
      "[role='alert'], [aria-live='assertive'], [class*='error'], [class*='invalid']",
    )].filter(isVisible);

    return {
      url: location.href,
      title: document.title,
      modalOpen: modalOpen(),
      controlCount: controls.length,
      fieldCount: fields.length,
      errorCount: errors.length,
      bodyTextHash: hashString(stableBodyText()),
      applicationState: opts.applicationState || null,
      capturedAt: Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // Security signals
  // -------------------------------------------------------------------------

  function securitySignals() {
    const frameSources = [...document.querySelectorAll("iframe")]
      .filter(isVisible)
      .map((f) => f.getAttribute("src") || "")
      .filter(Boolean);

    const passwordField = document.querySelector("input[type='password']");

    // A board that has signed the user out puts its own panel in the way
    // instead of a plain form — LinkedIn's auth wall, a "join to continue"
    // overlay, a checkpoint interstitial.
    const wall = document.querySelector(
      "[class*='auth-wall'], [class*='authwall'], [class*='join-form'], [class*='challenge']",
    );

    return {
      pageText: visibleBodyText(2500),
      frameSources,
      passwordFieldVisible: Boolean(passwordField && isVisible(passwordField)),
      authWall: Boolean(wall && isVisible(wall)),
      pathname: location.pathname,
    };
  }

  // -------------------------------------------------------------------------
  // Snapshot assembly
  // -------------------------------------------------------------------------

  /**
   * Build a complete UISnapshot.
   *
   * Backwards compatible: `controls` is still present (the existing prompt and
   * executors use it), and `elements` is the new general list. They are the
   * same array — the alias keeps older call sites working.
   *
   * @param {object} opts
   * @param {Element} [opts.root]              Subtree to observe
   * @param {string}  [opts.applicationState]  Adapter's own state label
   * @param {object[]} [opts.questions]        Adapter-extracted questions
   * @param {string[]} [opts.errors]
   * @param {string[]} [opts.successIndicators]
   * @param {boolean} [opts.loading]
   * @param {string}  [opts.platform]
   */
  function buildSnapshot(opts = {}) {
    resetRegistry();

    const root = opts.root || document.body;
    const elements = collectElements(root, opts.limit || 120);
    const core = globalThis.__autoApplyInteractionCore;
    const applyCandidates = core ? core.findApplyCandidates(elements) : [];

    return {
      page: {
        url: location.href,
        title: document.title,
        hostname: location.hostname,
        applicationState: opts.applicationState || "unknown",
        platform: opts.platform || "generic",
        modalOpen: modalOpen(),
        scroll: {
          y: Math.round(window.scrollY || 0),
          maxY: Math.max(0, Math.round((document.body?.scrollHeight || 0) - window.innerHeight)),
        },
      },
      questions: opts.questions || [],
      elements,
      controls: elements, // alias retained for existing executors/prompt
      applyCandidates,
      messages: opts.messages || [],
      errors: opts.errors || [],
      successIndicators: opts.successIndicators || [],
      loading: Boolean(opts.loading),
      fingerprint: fingerprint({ applicationState: opts.applicationState }),
    };
  }

  // -------------------------------------------------------------------------
  // Logical target resolution (Part 3 + Part 13)
  // -------------------------------------------------------------------------

  /**
   * Resolve an element_N to a LIVE element, re-finding it if the original node
   * was replaced by a rerender.
   *
   * @param {string} id
   * @returns {{el: Element, meta: object, reresolved: boolean} | {error: string, stale?: boolean}}
   */
  function resolveLive(id) {
    if (!id) return { error: "no target element ID provided" };
    if (!/^element_\d+$/.test(id)) return { error: `invalid element ID format: "${id}"` };

    const entry = registry.get(id);
    if (!entry) return { error: `element "${id}" is not in the current snapshot`, stale: true };

    const core = globalThis.__autoApplyInteractionCore;
    const expected = entry.meta;

    // 1. Is the original node still the control we meant?
    const original = entry.el;
    if (original && original.isConnected) {
      const actual = describe(original);
      const verdict = core
        ? core.isStaleTarget(expected, actual)
        : { stale: !actual.visible, reason: "not visible" };
      if (!verdict.stale) {
        return { el: original, meta: actual, reresolved: false };
      }
    }

    // 2. Stale — re-find it by its logical metadata among live elements.
    const live = [];
    for (const el of collectCandidates(document.body)) {
      if (!isMeaningfulControl(el) || !isVisible(el)) continue;
      live.push({ el, meta: describe(el) });
    }

    if (core) {
      const best = core.resolveLogicalTarget(
        expected,
        live.map((c, i) => ({ ...c.meta, id: String(i) })),
      );
      if (best) {
        const picked = live[Number(best.id)];
        rebind(id, picked.el);
        return { el: picked.el, meta: picked.meta, reresolved: true, matchScore: best.score };
      }
    }

    return {
      error: `element "${id}" (${expected.text || expected.ariaLabel || expected.tag}) is stale and could not be re-found`,
      stale: true,
    };
  }

  globalThis.__autoApplyObserverCore = {
    // observation
    buildSnapshot, collectElements, collectCandidates, describe,
    describeAll, fingerprint, securitySignals,
    // registry
    resolveLive, getMeta, getRawElement, rebind, rebindStale, resetRegistry, registerElement,
    // primitives
    isVisible, isInViewport, innerText, rectOf, visibleLabelOf, modalOpen,
    isMeaningfulControl, hashString, visibleBodyText,
  };
}());
