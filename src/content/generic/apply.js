// Generic company-career-site adapter — shim only.
//
// All logic is now in the AI agent loop (generic/agent-loop.js).
// This file is kept for compatibility; it registers the globalThis.genericApply
// symbol that legacy callers check for, and delegates everything to the loop.
//
// Injection order (enforced by service-worker.js):
//   1. src/content/shared/highlight.js   — visual ring
//   2. src/content/generic/observer.js   — UISnapshot builder
//   3. src/content/generic/executor.js   — action executor
//   4. src/content/generic/agent-loop.js — Claude-style loop + message listener
//   5. src/content/generic/apply.js      — this shim (idempotent guard)

(function () {
  if (globalThis.genericApply) return;
  // The agent-loop.js already registered the chrome.runtime.onMessage listener
  // for GENERIC_APPLY and GENERIC_CONTINUE. Nothing more needed here.
  globalThis.genericApply = { delegatedTo: "genericAgentLoop" };
}());
