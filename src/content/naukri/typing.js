// Input primitives for Naukri's drawer. Classic content script.
//
// Two things here are the difference between working and silently doing
// nothing, and neither is guessable from the markup:
//
//  1. .textArea is a contenteditable DIV. Assigning .value is a no-op that
//     throws no error. React only updates when it sees a real 'input' event.
//  2. A file input's .files is read-only to normal page script, but CAN be set
//     from an extension content script via DataTransfer - which is how the
//     resume gets attached without the user touching a file picker.

/** Type into a contenteditable div the way a human would, so React sees it. */
async function typeInto(el, value, { perChar = 12 } = {}) {
  el.focus();

  // Clear anything already there.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand("delete");

  // insertText fires beforeinput/input per character, which is what React
  // listens for. Setting textContent in one shot does not.
  for (const ch of String(value)) {
    document.execCommand("insertText", false, ch);
    if (perChar) await new Promise((r) => setTimeout(r, perChar));
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  // Verify: if the node is still empty the execCommand path was blocked.
  if (!el.textContent.trim()) {
    el.textContent = String(value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: String(value) }));
  }
  return el.textContent.trim() === String(value).trim();
}

/** Press Enter to commit the current drawer answer. */
function pressEnter(el) {
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new KeyboardEvent(type, {
      key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }));
  }
}

/**
 * Attach a stored resume to a file input without opening a file picker.
 * `file` is a File reconstructed from the blob the user uploaded to the
 * extension - see src/lib/resume.js.
 */
function attachFile(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input.files.length === 1;
}

/** Find the control that commits an answer (labelled Save or Send). */
function commitButton(root = document) {
  return [...root.querySelectorAll("button, div[class*='btn'], div[class*='Btn']")]
    .find((b) => {
      const t = (b.innerText || "").trim().toLowerCase();
      const r = b.getBoundingClientRect();
      return (t === "save" || t === "send") && r.width > 0 && r.height > 0;
    }) || null;
}

globalThis.naukriType = { typeInto, pressEnter, attachFile, commitButton };
