// A minimal DOM harness for exercising the content-script modules in Node.
//
// The content scripts are classic IIFEs that attach themselves to globalThis.
// This harness builds a small but faithful DOM — enough for element walking,
// visibility, rects, events and rerenders — then evaluates those scripts
// against it, so the executor's verification logic can be tested without a
// browser or a jsdom dependency.
//
// It is deliberately small: it implements the DOM surface the modules actually
// use, and nothing else. Where a real browser differs in ways that matter
// (layout, hit testing), the harness lets a test set values explicitly.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

class Evt {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
}

// ---------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------

let uid = 0;

class El {
  constructor(tagName, doc) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = { visibility: "visible", display: "block", opacity: "1", cursor: "auto" };
    this._uid = ++uid;
    this._text = "";
    this._rect = { x: 0, y: 0, width: 100, height: 30 };
    this.shadowRoot = null;
    this.disabled = false;
    this.readOnly = false;
    this.checked = false;
    this.value = "";
    this.files = null;
    this.options = [];
    this.selectedIndex = -1;
  }

  // -- tree ----------------------------------------------------------------

  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }

  /** The parent, but only when it is an element (not the document). */
  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null;
  }

  appendChild(child) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  /** Modern variadic append, used by overlay code. */
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild(next, prev) {
    const i = this.childNodes.indexOf(prev);
    if (i < 0) return null;
    this.childNodes[i] = next;
    next.parentNode = this;
    prev.parentNode = null;
    return prev;
  }

  remove() { this.parentNode?.removeChild(this); }

  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  closest(selector) {
    for (let n = this; n; n = n.parentNode) {
      if (n.nodeType === 1 && n.matches?.(selector)) return n;
    }
    return null;
  }

  get isConnected() {
    for (let n = this; n; n = n.parentNode) if (n === this.ownerDocument?.body) return true;
    return false;
  }

  // -- attributes -----------------------------------------------------------

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "type") this.type = String(value);
    if (name === "name") this.name = String(value);
    if (name === "id") this.id = String(value);
    if (name === "value") this.value = String(value);
    if (name === "disabled") this.disabled = true;
    if (name === "contenteditable") this.isContentEditable = value === "true";
  }
  getAttribute(name) {
    if (name === "type" && this.type != null && !this.attributes.has("type")) return this.type;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }

  get id() { return this.attributes.get("id") || ""; }
  set id(v) { this.attributes.set("id", String(v)); }

  get className() { return this.attributes.get("class") || ""; }
  set className(v) { this.attributes.set("class", String(v)); }

  // -- text -----------------------------------------------------------------

  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((n) => (n.nodeType === 1 ? n.textContent : n._text || "")).join("");
  }
  set textContent(v) {
    this.childNodes = [];
    this._text = String(v);
  }
  /**
   * Minimal innerHTML. Markup is stored verbatim rather than parsed: the
   * modules under test use it only for inline decorative SVG, and nothing
   * queries into that subtree.
   */
  get innerHTML() { return this._html ?? this.textContent; }
  set innerHTML(v) {
    this.childNodes = [];
    this._html = String(v);
    this._text = "";
  }

  get innerText() {
    // Invisible subtrees contribute no text, as in a real browser.
    if (this.style.display === "none" || this.style.visibility === "hidden") return "";
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes
      .map((n) => (n.nodeType === 1 ? n.innerText : n._text || ""))
      .join(" ").replace(/\s+/g, " ").trim();
  }
  set innerText(v) { this.textContent = v; }

  // -- geometry -------------------------------------------------------------

  getBoundingClientRect() {
    const r = this._rect;
    return {
      x: r.x, y: r.y, width: r.width, height: r.height,
      left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height,
    };
  }
  setRect(rect) { this._rect = { ...this._rect, ...rect }; return this; }
  scrollIntoView() { this._scrolledIntoView = true; }

  // -- events ---------------------------------------------------------------

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((f) => f !== fn));
  }
  dispatchEvent(evt) {
    evt.target = evt.target || this;
    for (let node = this; node; node = node.parentNode) {
      const list = node.listeners?.get(evt.type);
      if (list) {
        evt.currentTarget = node;
        for (const fn of [...list]) fn.call(node, evt);
      }
      if (!evt.bubbles || evt._stopped) break;
    }
    return !evt.defaultPrevented;
  }

  /**
   * The native activation behaviour. Tests override this to simulate a page
   * that ignores a programmatic click (the Test 2 / Test 9 scenario).
   */
  click() {
    this.dispatchEvent(new Evt("click", { bubbles: true, cancelable: true }));
  }

  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  select() {}

  // -- queries --------------------------------------------------------------

  matches(selector) { return matchesSelector(this, selector); }

  querySelectorAll(selector) {
    const out = [];
    const parts = String(selector).split(",").map((s) => s.trim()).filter(Boolean);
    const walk = (node) => {
      for (const child of node.children) {
        if (parts.some((p) => matchesSelector(child, p))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

// ---------------------------------------------------------------------------
// Selector matching — supports the subset the modules use
// ---------------------------------------------------------------------------

function matchesSelector(el, selector) {
  const sel = selector.trim();
  if (!sel || el.nodeType !== 1) return false;

  // Descendant combinators are not needed by the modules under test; a
  // selector's last simple part is matched, which is sufficient here.
  const simple = sel.split(/\s+/).pop();

  // Compound: tag + #id + .class + [attr]
  const re = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[^\]]+\]|:not\([^)]+\))*)$/;
  const m = re.exec(simple);
  if (!m) return false;

  const [, tag, rest = ""] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;

  const tokens = rest.match(/[#.][\w-]+|\[[^\]]+\]|:not\([^)]+\)/g) || [];
  for (const token of tokens) {
    if (token.startsWith("#")) {
      if (el.id !== token.slice(1)) return false;
    } else if (token.startsWith(".")) {
      if (!el.className.split(/\s+/).includes(token.slice(1))) return false;
    } else if (token.startsWith(":not(")) {
      if (matchesSelector(el, token.slice(5, -1))) return false;
    } else if (token.startsWith("[")) {
      if (!matchesAttr(el, token.slice(1, -1))) return false;
    }
  }
  return true;
}

function matchesAttr(el, expr) {
  const m = /^([\w-]+)(?:([~^$*|]?=)\s*["']?([^"'\]]*)["']?)?(\s+i)?$/.exec(expr.trim());
  if (!m) return false;
  const [, name, op, rawValue, ci] = m;
  const actual = el.getAttribute(name);
  if (actual == null) return false;
  if (!op) return true;

  const a = ci ? actual.toLowerCase() : actual;
  const v = ci ? String(rawValue).toLowerCase() : String(rawValue);

  switch (op) {
    case "=": return a === v;
    case "*=": return a.includes(v);
    case "^=": return a.startsWith(v);
    case "$=": return a.endsWith(v);
    case "~=": return a.split(/\s+/).includes(v);
    case "|=": return a === v || a.startsWith(v + "-");
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Document / window
// ---------------------------------------------------------------------------

/**
 * Build a fresh DOM environment and evaluate the given content-script files
 * against it.
 *
 * @param {object} [opts]
 * @param {string} [opts.url]
 * @param {string} [opts.title]
 * @param {string[]} [opts.scripts]  Paths relative to the repository root
 * @returns {object} the sandbox globalThis, plus helpers
 */
export function createEnvironment(opts = {}) {
  const doc = {
    nodeType: 9,
    title: opts.title || "Test page",
    activeElement: null,
  };

  doc.documentElement = new El("html", doc);
  doc.head = new El("head", doc);
  doc.body = new El("body", doc);
  doc.documentElement.appendChild(doc.head);
  doc.body.setRect({ x: 0, y: 0, width: 1280, height: 4000 });
  doc.documentElement.appendChild(doc.body);
  doc.body.scrollHeight = 4000;

  doc.createElement = (tag) => new El(tag, doc);
  // Search the whole document: styles live in <head>, content in <body>.
  doc.querySelectorAll = (sel) => doc.documentElement.querySelectorAll(sel);
  doc.querySelector = (sel) => doc.documentElement.querySelector(sel);
  doc.getElementById = (id) => doc.documentElement.querySelector(`#${id}`);
  doc.contains = (el) => doc.body.contains(el) || el === doc.body;
  doc.elementFromPoint = (x, y) => {
    // Topmost element whose rect contains the point; later in document order
    // wins, which is close enough to paint order for these tests.
    let hit = null;
    for (const el of doc.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        hit = el;
      }
    }
    return hit;
  };

  const url = new URL(opts.url || "https://example.test/jobs/123");
  const location = {
    get href() { return url.href; },
    set href(v) { Object.assign(url, new URL(v, url)); },
    get hostname() { return url.hostname; },
    get pathname() { return url.pathname; },
  };

  const sandbox = {
    document: doc,
    location,
    window: null,
    navigator: { userAgent: "node-test" },
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    screenX: 0,
    screenY: 0,
    setTimeout,
    clearTimeout,
    console,
    CSS: { escape: (s) => String(s).replace(/([^\w-])/g, "\\$1") },
    Event: Evt,
    CustomEvent: Evt,
    MouseEvent: Evt,
    PointerEvent: Evt,
    KeyboardEvent: Evt,
    InputEvent: Evt,
    getComputedStyle: (el) => el.style,
    scrollBy: ({ top = 0, left = 0 } = {}) => {
      sandbox.scrollY = Math.max(0, sandbox.scrollY + top);
      sandbox.scrollX = Math.max(0, sandbox.scrollX + left);
    },
    HTMLInputElement: { prototype: {} },
    HTMLTextAreaElement: { prototype: {} },
    DataTransfer: class { constructor() { this.items = { add: () => {} }; this.files = []; } },
    File: class { constructor(bits, name, o) { this.name = name; this.type = o?.type; } },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    history: {
      // A real browser restores the previous page on back(). Tests that care
      // about navigation register a restore function; others just record it.
      back: () => {
        sandbox.__historyDelta = -1;
        try { sandbox.__onHistoryBack?.(); } catch (_) { /* test-supplied */ }
      },
      forward: () => { sandbox.__historyDelta = 1; },
    },
    // chrome.* is stubbed; content modules must tolerate its absence/failure.
    chrome: {
      runtime: {
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener: (fn) => sandbox.__messageListeners.push(fn) },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  // Every frame of a page runs these scripts. A document is the page itself
  // unless the test asks for an embedded one, which sees a different `top`.
  sandbox.top = opts.frame ? { embedded: true } : sandbox;
  sandbox.parent = sandbox.top;
  /** Listeners registered through chrome.runtime.onMessage, for tests to drive. */
  sandbox.__messageListeners = [];

  for (const file of opts.scripts || []) loadScript(sandbox, file);

  return {
    sandbox,
    document: doc,
    /** Create and attach an element in one call. */
    make(tag, props = {}, parent = doc.body) {
      const el = new El(tag, doc);
      const { rect, text, style, ...attrs } = props;
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null) continue;
        if (k === "checked" || k === "disabled") { el[k] = v; if (v) el.setAttribute(k, ""); }
        else el.setAttribute(k, v);
      }
      if (text != null) el.textContent = text;
      if (rect) el.setRect(rect);
      if (style) Object.assign(el.style, style);
      parent.appendChild(el);
      return el;
    },
    El,
    Evt,
  };
}

function loadScript(sandbox, relativePath) {
  const path = fileURLToPath(new URL("../../" + relativePath, import.meta.url));
  const source = readFileSync(path, "utf8");
  // Content scripts reference bare globals (document, location, …), so they
  // are evaluated with those names bound as parameters.
  const names = Object.keys(sandbox);
  const fn = new Function(...names, source);
  fn(...names.map((n) => sandbox[n]));
}

export { El, Evt };
