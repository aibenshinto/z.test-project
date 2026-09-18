// Tests for the side panel's own wiring.
//
// The panel is the one part of the extension with no DOM harness behind it:
// panel.js reaches for elements by id and panel.html declares them, and
// nothing checked that the two agree. An edit that removed a section while
// leaving its handler behind, or duplicated a block of markup, left a panel
// that throws on load or silently binds to the wrong element — with the whole
// suite still green.
//
// Run with: node --test tests/panel.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path) => readFileSync(fileURLToPath(new URL("../" + path, import.meta.url)), "utf8");

const HTML = read("src/sidepanel/panel.html");
const JS = read("src/sidepanel/panel.js");

const htmlIds = [...HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
const jsIds = new Set([...JS.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]));

test("no element id is declared twice", () => {
  const seen = new Set();
  const duplicates = htmlIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  assert.deepEqual([...new Set(duplicates)], [],
    "a duplicated id means a block of markup was spliced in twice");
});

test("every element the panel script reaches for exists in the markup", () => {
  const missing = [...jsIds].filter((id) => !seenIn(htmlIds, id)).sort();
  assert.deepEqual(missing, [], "panel.js would get null for these and throw on load");
});

test("no control is left in the markup with nothing listening to it", () => {
  // Sections are addressed by the tab bar rather than by $(), and the status
  // line is written through its own element reference.
  const addressedElsewhere = new Set([...HTML.matchAll(/id="(tab-[^"]+)"/g)].map((m) => m[1]));
  const orphans = htmlIds
    .filter((id) => !jsIds.has(id) && !addressedElsewhere.has(id))
    .filter((id) => new RegExp(`id="${id}"[^>]*>`).test(HTML))
    .sort();
  assert.deepEqual(orphans, [], "these are left over from a removed feature");
});

test("the panel only asks the worker for messages the worker answers", () => {
  const worker = read("src/background/service-worker.js");
  const answered = new Set([...worker.matchAll(/case "([A-Z_]+)":/g)].map((m) => m[1]));
  // What the panel sends to the content script instead of the worker. The
  // run itself is the worker's, so it survives the page navigating.
  const toThePage = new Set(["TAKEOVER_PROBE", "SET_CURSOR_VISIBLE"]);

  const sent = [...JS.matchAll(/type:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
  const unanswered = [...new Set(sent)].filter((t) => !answered.has(t) && !toThePage.has(t)).sort();
  assert.deepEqual(unanswered, [], "the panel would wait for a reply that never comes");
});

function seenIn(ids, id) {
  return ids.includes(id);
}

test("the panel declares its encoding, so its dashes are not garbled", () => {
  // Without it Chrome decoded the page in the system's legacy encoding on
  // Windows, and every non-ASCII character in the markup came out garbled.
  assert.match(HTML.slice(0, 1024), /<meta charset="utf-8">/i);
});

test("the panel takes a run's result from the message the worker sends when it ends", () => {
  // The worker answers TAKEOVER_START as the run begins, so the result can
  // only arrive this way; a panel that waited on the reply would never see it.
  const worker = read("src/background/service-worker.js");
  assert.match(worker, /type: "TAKEOVER_DONE"/);
  assert.match(JS, /msg\?\.type === "TAKEOVER_DONE"/);
});
