
# AutoApply architecture

## Inspection record — 2026-09-13

This document was produced after reading every source file in the repository,
the manifest, and the current uncommitted worktree. There is no server, build
tool, package manifest, or automated test suite: this is a browser-native,
unbundled Chrome Manifest V3 extension. The baseline commit contains the
Naukri-only workflow; the worktree adds the state machine, evaluator, question
policy, logging, LinkedIn discovery stub, and resumability work described below.

**Critical repair before feature work:** `src/background/service-worker.js`
currently contains an orphaned duplicate-detection function body (lines 87–93)
without its `function duplicateOf(...)` declaration. It must be restored before
Chrome can reliably load the service worker. The first implementation increment
repairs that defect, tightens the no-guess answer policy, and exposes the
already-added human-in-the-loop state in the side panel.

Source of truth: the existing Chrome MV3 extension in this directory. This document records what already works, what the product requirements still need, and how new work should attach to the current design rather than replace it.

## 1. Current architecture

```
Side panel (panel.html / panel.js)
        │  chrome.runtime.sendMessage
        ▼
Service worker (src/background/service-worker.js)
        │  chrome.storage.local + chrome.alarms
        ├─ Governor (rate limits, kill switch, halt)
        ├─ Resume / profile (PDF → Gemini JSON)
        ├─ Heuristic ranker + optional LLM rerank
        ├─ Answer bank (normalize → cache → LLM)
        ├─ AI Decision Engine (ui-agent.js → askJSON → uiAction route)
        └─ LLM router (askJSON → Gemini / OpenAI / Claude)
                │  tabs.create + tabs.sendMessage
                ▼
Naukri content scripts (classic, shared globals)
        selectors → scrape / typing
        observer  → UI snapshot (element_N registry)
        executor  → controlled action + verification
        agent-loop → observe → AI_DECIDE_ACTION → execute → verify
        apply     → chatbot-drawer path (preserved) + mode routing
        main.js   → message bridge
                ▼
Authenticated Naukri pages (user session cookies)
```

There is **no backend**. All persistence is `chrome.storage.local`. The service worker is treated as ephemeral: no module-level run state, ticks via `chrome.alarms`.

### What already works

| Area | Implementation |
|---|---|
| MV3 layout | `manifest.json`, side panel on action click |
| LLM abstraction | `src/lib/llm/index.js` `askJSON({ task, schema })` |
| API keys | Stored in `chrome.storage.local`, used only from the worker / side panel modules, **not** from content scripts |
| Resume store | Encoded `{ name, mime, b64 }` — files cannot cross `sendMessage` |
| Profile parse | Gemini multimodal PDF → JSON; validation gate before apply |
| Manual profile | Side panel + `profile.seed.json` |
| Job scrape | Naukri SRP cards, dedupe by `data-job-id` |
| Ranking | Local heuristic (skills / years / location / recency) + optional model rerank |
| Apply driver | Naukri chatbot drawer (free-text path) **preserved**; new AI agent loop for radio/form questionnaires |
| UI Observer | `observer.js` — DOM → compact `UISnapshot`; `element_N` registry; no raw HTML sent to AI |
| AI Decision Engine | `src/lib/ui-agent.js` (worker-side); `buildCandidateContext`, `validateAction`, `decideAction`; `AI_DECIDE_ACTION` message |
| Browser Action Executor | `executor.js` — resolves `element_N`, performs 10 controlled action types, verifies each action independently |
| AI Agent Loop | `agent-loop.js` — observe → decide → execute → verify cycle; `submitted: true` only from `naukriApplicationSubmitted()` |
| Submission proof | Apply button text / applied marker — **not** "drawer opened", **not** AI claim |
| Anomalies | Visible reCAPTCHA iframe, registration redirect, rate-limit selectors; halt, do not bypass |
| Governor | Daily/hourly caps, random delay, min relevance, master switch default **off** |
| Answer cache | Normalized string key; LLM only on miss; confidence &lt; 0.5 → skip guess |

### Important behavioural facts (do not regress)

1. Naukri `.textArea` is **contenteditable**. Setting `.value` is a silent no-op.
2. Incomplete Naukri profiles reuse the apply drawer for resume/headline nags. Detect and **HALT the run**.
3. `#apply-button` is not unique; always pick a **visible** node.
4. Hashed CSS-module classes must be matched with `[class*='prefix']`.
5. Broad `[class*='captcha']` false-positives on a healthy SRP — only match a visible challenge frame.
6. External apply (`#company-site-button`) is not in-place Naukri apply.

## 2. Gap analysis

| Requirement | Already implemented? | Missing |
|---|---|---|
| Resume upload PDF | Yes | TXT path; DOCX is accepted in the file picker but not parsed locally |
| Structured profile | Partial (name, title, headline, location, years, skills, preferred locations) | Education list, experience list, projects, certs, languages, links, salary, notice, work auth, visa, remote pref, etc. |
| Editable extra facts | Partial (manual profile form) | Preferences object, excluded companies, employment types, salary floor |
| Job evaluation APPLY/SKIP/REVIEW | Partial (0–1 relevance + minRelevance skip) | Explicit decision object, conservative experience hard-skip, missing-requirement / risk flags |
| Platform abstraction | No (Naukri globals only) | Registry + LinkedIn + generic career-site adapter |
| LinkedIn | Discovery plus bounded Easy Apply adapter | Live-DOM verification and generic external-ATS routing remain |
| Content vs orchestration | Mostly yes | Apply loop still mixes Naukri DOM + answer policy in `apply.js` |
| Form field types | Naukri chat text + file only → **radio/select questionnaire panels now handled by AI agent loop** | Generic inputs, checkboxes, dates still pending |
| Semantic question match | Weak (string normalize + Naukri templates) | Alias groups, similarity, confirmation band |
| Human-in-the-loop pause | No — unanswerable → `needs_review`, tab **closed**, next job | Keep tab, `WAITING_FOR_USER`, sidebar prompt, save & continue |
| Confidence bands | Low → null only | Auto / confirm / ask; sensitive categories always confirm unless user-sourced |
| State machine | Implicit queue statuses | Named agent states, resumable session after SW eviction |
| Sidebar live job / question | Stats + tabs | Current job, match, progress, blocked CAPTCHA UI, pause |
| External company sites | Detected and skipped | Optional origin permission + generic form driver |
| CAPTCHA / bot walls | Detect + halt (Naukri) | Same policy on LinkedIn/generic; **never solve/bypass** |
| Timeouts / retries | Some waits; Gemini 503 retry | Per-action timeout policy, apply tab not closed on wait |
| Job tracking | `queue[]` in storage | Richer statuses, applied-at, failure reason, duplicate by URL+company+title |
| Rate / pause / stop | Start/stop + halt; no pause | Pause that preserves session; emergency stop already exists |
| Privacy delete | Yes — side panel action | Clears profile, resume, answer bank, queue/history, logs, API keys, and agent settings |
| Structured logs | `console.debug` + panel log | Persistent event log without secrets |
| Tests | Manual 2026-09-08 notes | Automated unit tests |
| Searches setting | Default `searches: []` unused | Optional; scrape-by-URL is enough for now |

## 3. Proposed architecture (adapted to this repo)

Keep MV3 + alarms + storage. Add a **named agent session** next to the existing queue. Do not introduce a Python backend or a bundler unless a later phase needs one.

```
Extension UI (side panel)
      ↓ messages
Background service worker
      ↓
Application orchestrator (tick + session)
      ├─ Governor
      ├─ Evaluator (heuristic + optional LLM)
      ├─ AI layer (existing askJSON)
      ├─ Candidate profile + knowledge base
      └─ Platform registry
            ↓ tabs / scripting
Content scripts (DOM only)
      ├─ naukri/   (existing, keep)
      ├─ linkedin/ (new, conservative)
      └─ generic/  (injected on known apply tabs)
            ↓
Naukri / LinkedIn / company ATS
```

**Rule:** the model returns JSON (`FILL_FIELD`, `ASK_USER`, `SKIP_JOB`, …). The worker validates the action. The content script only performs DOM operations that the worker requested.

## 4. Data model (`chrome.storage.local`)

Keep flat keys (already the pattern). No IndexedDB required yet.

| Key | Purpose |
|---|---|
| `llm` | Keys + per-task routes (existing) |
| `governor` | Caps, delays, minRelevance, enabled (existing) |
| `confidence` | `{ auto, confirm }` thresholds |
| `profile` | Structured candidate (expanded) |
| `resumeFile` | Encoded resume blob |
| `preferences` | Job search preferences |
| `answerBank` | Normalized question → answer |
| `queue` | Jobs + status + evaluation |
| `agentSession` | Resumable FSM snapshot |
| `eventLog` | Structured debug events (redacted) |
| `submitLog` | Governor history (existing) |
| `haltedAt` / `haltReason` | Breaker (existing) |

### Entities (logical)

- **CandidateProfile** — `profile`
- **Resume** — `resumeFile` (+ optional `resumeText` for TXT)
- **JobPreferences** — `preferences`
- **CandidateAnswer** — `answerBank` entries
- **Job** — queue item
- **AgentSession** — current run
- **ApplicationEvent** — `eventLog` row

Omit separate SQL tables. Omit `ApplicationQuestion` rows until multi-step ATS tracking needs them.

## 5. State machine

```
IDLE
  → DISCOVERING_JOB     (scrape or take next queued job)
  → EVALUATING_JOB
       → SKIPPED        → DISCOVERING_JOB
       → REVIEW         → WAITING_FOR_USER (optional apply)
       → APPLY
            → OPENING_APPLICATION
            → EXTRACTING_FORM
            → ANSWERING_FORM
                 → WAITING_FOR_USER → ANSWERING_FORM
                 → BLOCKED (captcha / login / challenge) → user skip or stop
                 → FAILED → DISCOVERING_JOB
                 → SUBMITTING → COMPLETED → DISCOVERING_JOB
PAUSED / STOPPED can interrupt any active state except that
BLOCKED never attempts to bypass security UI.
```

Session fields: `state`, `jobId`, `tabId`, `pendingQuestion`, `progress`, `paused`, `updatedAt`.

On service-worker restart: restore `agentSession` from storage; if `tabId` is gone, mark `FAILED` with `tab_closed` and continue or wait.

## 6. Security / privacy

| Risk | Mitigation |
|---|---|
| API keys in storage | Never send keys to content scripts; password field in panel; user can delete |
| Keys in host_permissions fetch | Required for unpacked personal use; do not ship keys in the repo |
| Full resume to LLM | Parse **once**; later calls send structured profile slices, not the PDF |
| Resume b64 to content script | Only for file-input attach on the apply tab |
| Passwords | Never requested or stored |
| Broad page access | Naukri/LinkedIn/Indeed hosts today; generic ATS via **optional** origin permission, not `<all_urls>` content scripts |
| User session cookies | Inherited by content scripts; no login automation |
| CAPTCHA / Cloudflare | Detect, halt/block, tell the user. **No solving, no stealth** |
| Logs | Do not log resume text, API keys, or full page HTML |
| Sensitive questions (visa, crime, disability, demographics) | User confirmation unless an explicit user-sourced bank answer exists |

## 7. Implementation plan (incremental)

### Step A — Architecture record (this file)

- Create: `ARCHITECTURE.md`
- Test: documentation only

### Step B — Core profile + preferences

- Modify: `src/lib/resume.js`, `src/lib/storage.js`, `src/sidepanel/panel.html`, `panel.js`
- Why: product profile is richer than the Naukri-minimum fields
- Expect: upload PDF/TXT, parse, edit extra fields, persist preferences
- Test: `validateProfile` still gates apply; new fields optional

### Step C — Evaluator + knowledge + FSM + logger (pure modules)

- Create: `src/lib/evaluator.js`, `src/lib/questions.js`, `src/lib/agent-fsm.js`, `src/lib/logger.js`
- Modify: `src/lib/answer-bank.js`, `src/lib/ranker.js` (keep heuristic)
- Why: decisions and answers must be conservative and testable without DOM
- Test: node unit tests for match/skip, similar questions, transitions

### Step D — Orchestrator resumability + HITL

- Modify: `src/background/service-worker.js`, `src/content/naukri/apply.js`
- Why: unanswerable questions must pause with the tab still open
- Expect: sidebar prompt → save answer → continue same job
- Test: unit tests for wait payload; manual Naukri later

### Step E — Side panel live agent UI

- Modify: panel HTML/JS
- Why: user must see state, pause, stop, blocked reason, history
- Test: load unpacked, walk tabs

### Step F — Platform registry + LinkedIn/generic stubs

- Create: `src/lib/platforms.js`, LinkedIn content stubs, generic form extractor
- Modify: `manifest.json`
- Why: isolate Naukri; allow later Easy Apply without rewriting the worker
- Status: LinkedIn discovery and the bounded Easy Apply adapter are registered
  in the manifest. External-company routes remain an explicit handoff.
- Test: probe messages; no CAPTCHA interaction

### Step G — Tests

- Create: `tests/*.test.js`, `package.json` test script
- Run: `npm test`

### Step H — AI-controlled UI agent layer (2026-09-14)

- Create: `src/content/naukri/observer.js` — DOM → UISnapshot; `element_N` registry
- Create: `src/content/naukri/executor.js` — controlled Browser Action Executor + Verification Engine
- Create: `src/content/naukri/agent-loop.js` — observe → AI decide → execute → verify loop
- Create: `src/lib/ui-agent.js` — `buildCandidateContext`, `validateAction`, `decideAction` (worker-side, no DOM)
- Modify: `src/content/naukri/apply.js` — add `detectApplicationMode()`; route radio/form questionnaire to agent loop; chatbot-drawer path unchanged
- Modify: `src/background/service-worker.js` — import `ui-agent.js`; add `AI_DECIDE_ACTION` message handler
- Modify: `manifest.json` — register three new content scripts before `apply.js`
- Modify: `src/lib/storage.js` — add `uiAction` LLM task route
- Create: `tests/ui-agent.test.js` — 20 new tests for context builder, action validator, decision engine
- Why: the existing chatbot-drawer path only handles free-text inputs; Naukri's radio-button questionnaire panels require a flexible AI-driven approach that generalises across question types without hard-coded rules
- Safety invariants enforced: AI cannot supply CSS selectors or JS code; API keys stay in the service worker; `submitted: true` requires `naukriApplicationSubmitted()` confirmation; missing candidate data → `ask_user`, never invented
- Test: `npm test` — 27/27 pass (7 original + 20 new)

## 8. Non-goals for this increment

Resume tailoring, cover letters, multiple profiles, interview prep, email tracking, Indeed adapter, CAPTCHA solving, automated login, Selenium.

## 9. Risks

- Naukri and LinkedIn DOM will change; selectors stay layered and marked VERIFIED/UNVERIFIED.
- Easy Apply and third-party ATS flows are heterogeneous; generic fill will pause often (by design).
- Gemini 503s already retried; other providers may still fail a tick.
- Real submission on Naukri was previously blocked by an incomplete site profile, not by the driver.

## 10. Implemented increment status

- The service-worker duplicate-detection declaration has been restored; the
  worker parses as an MV3 module again.
- The profile editor retains parsed fields it does not display and exposes
  contact, work-authorisation, salary, relocation, and remote-preference data.
- Configured preferences affect deterministic scoring: excluded
  companies/keywords skip a job; non-target titles and absent required keywords
  require review.
- A structured model decision is requested only for the selected job just
  before application. Deterministic hard-skips cannot be overridden by a model.
- The side panel renders session state, pending questions, pause/resume, skip,
  and a user-initiated full data-deletion action.
- LinkedIn scripts support discovery and bounded Easy Apply. External ATS
  flows intentionally remain an explicit handoff for now.
- `npm test` covers evaluation, exclusions, answer safety/similarity, model
  guardrails, and finite-state transitions.
- Discovery now filters before queueing: only `APPLY` candidates and
  user-reviewable `REVIEW` candidates are retained. `SKIP` jobs are counted in
  the discovery result but not stored in the actionable queue.
- An unanswered question with a known profile mapping now pauses the run with
  a “Complete profile” action that opens the corresponding side-panel field.
  Free-form questions remain user-sourced answer-bank entries rather than
  being forced into an unrelated profile field.

### LinkedIn Easy Apply increment

The LinkedIn adapter now implements the extension workflow for in-page
Easy Apply dialogs: it opens only a visible button explicitly labelled “Easy
Apply,” derives field meaning from labels/legends/accessibility text, requests
answers from the service-worker knowledge policy, and uses only Next, Review,
and Submit Application workflow buttons. It checks for login, CAPTCHA, and
security challenges before each step, limits a run to eight dialog steps, and
requires an explicit completion indicator before recording a submission.

External-company application links remain outside this adapter and are returned
as an explicit handoff; no generic third-party ATS automation is claimed yet.

### AI-controlled UI agent layer increment (2026-09-14)

Four new files implement the AI → executor → verifier pipeline for Naukri's
radio/form questionnaire panels:

| File | Role |
|---|---|
| `src/content/naukri/observer.js` | Walks visible application DOM; produces compact `UISnapshot`; assigns temporary `element_N` IDs to interactive nodes |
| `src/content/naukri/executor.js` | Resolves element IDs; performs 10 allowed action types using existing typing utilities; verifies each action independently |
| `src/content/naukri/agent-loop.js` | Observe → `AI_DECIDE_ACTION` → execute → verify loop; terminates on `finish`/`stop`/`ask_user`/anomaly/`maxTurns` |
| `src/lib/ui-agent.js` | Worker-side: `buildCandidateContext` (safe profile slice), `validateAction` (schema enforcement), `decideAction` (LLM call via `uiAction` task route) |

The Naukri application driver (`apply.js`) now detects two modes via
`detectApplicationMode()`:
- **`"chatbot"`** — free-text drawer; the original `answerOne()` loop runs unchanged.
- **`"agent"`** — radio/form questionnaire; the AI agent loop runs instead.

Key constraints enforced in code:
- The AI receives only a compact snapshot — never raw HTML.
- The AI may only reference elements by their `element_N` ID — no CSS selectors, no XPath, no JavaScript.
- `submitted: true` is set only after `naukriApplicationSubmitted()` returns true — never from an AI `finish` action alone.
- API keys never reach content scripts; the `AI_DECIDE_ACTION` handler in the service worker is the sole LLM call site for UI decisions.
- Missing candidate data always produces `ask_user`, not an invented value.
- A new `uiAction` LLM task route in `storage.js` allows independent provider and model configuration for UI decisions.

`npm test` now runs 27 tests (7 original + 20 new in `tests/ui-agent.test.js`); all pass.

### Reliable browser interaction increment (2026-09-15)

The agent loop was reliable at *executing* actions and unreliable at knowing
whether the website had *accepted* them. Three near-identical observers,
executors and loops had each drifted, and all three reported
`el.click()` returning without throwing as success:

```js
el.click();
return { success: true, verified: document.contains(el) };   // before
```

The loop is unchanged in shape. What changed is that every step now compares
observed page state before and after the action.

#### Shared cores replace three copies

| File | Role |
|---|---|
| `src/lib/interaction-core.js` | Pure, DOM-free verdict logic: apply-intent ranking, page-state diffing, click classification, retry strategy, stale detection, submission gating, security policy. Unit-testable under `node --test`. |
| `src/content/shared/interaction-core-bridge.js` | The same logic as a classic script, since content scripts cannot `import`. A test asserts the two copies agree, so they cannot drift. |
| `src/content/shared/observer-core.js` | General element observation, element metadata, logical-target registry and re-resolution, page fingerprints. |
| `src/content/shared/pointer-actions.js` | DOM click, full pointer sequence, keyboard, scrolling. |
| `src/content/shared/executor-core.js` | Verified actions with DOM→pointer escalation and diagnostics. |
| `src/content/shared/agent-loop-core.js` | The observe → decide → execute → verify → reassess cycle, parameterised by a platform adapter. |
| `src/content/shared/diagnostics.js` | Structured per-interaction records; screenshot capture on failure when debugging. |
| `src/lib/debug-store.js` | Worker-side persistence of diagnostics and debug captures. |

Naukri, LinkedIn and generic are now **adapters** (~40–150 lines each) that
supply platform hints — which subtree to observe, the authoritative completion
check, anomaly rules — and nothing else. The core browser agent works without
them. Net change: **−1377 lines** across the rewritten files.

#### Action results are no longer binary

`ACTION_EXECUTED` (JavaScript ran) is now distinct from `ACTION_CONFIRMED`
(the page changed), `ACTION_NO_EFFECT` (it did not), `ACTION_FAILED` and
`ACTION_STALE`. A click escalates DOM click → pointer sequence → re-resolve +
pointer, bounded by `MAX_CLICK_RETRIES`, then hands back to the model with the
failure described and a screenshot attached.

#### Behavioural facts added (do not regress)

1. `element_N` is a **logical** target. Before every interaction the registry
   re-checks the node and, if a rerender replaced it, re-finds it by accessible
   name, role, tag and type. Position is never an identity test — a scrolled
   button is the same button.
2. Observers no longer filter controls by a job-application keyword list. That
   filter hid "Start application", "Get started" and every unlabelled
   `aria-label` button from the model. Apply intent is now a **ranking hint**
   (`applyCandidates`) alongside the full element list.
3. `submitted: true` requires the adapter's own check or an explicit
   confirmation message. A dialog opening, a step advancing or the model
   returning `finish` all yield `APPLICATION_STATUS_UNKNOWN`.
4. Pointer interaction exists to drive ordinary controls that ignore
   `.click()`. It is **never** used against a CAPTCHA or challenge: the
   security gate runs before every action and stops the run.
5. Screenshots are sent to the model only when the DOM was insufficient
   (target missing, click had no effect, page ambiguous), never every turn.
6. `navigate` / `open_tab` accept http(s) only, validated in both `ui-agent.js`
   and the worker. A `javascript:` URL is code execution by another name.

#### Action vocabulary

All ten original actions are retained. Added: `double_click`, `key_press`
(allow-listed keys), `scroll`, `scroll_to`, `go_back`, `go_forward`,
`navigate`, `switch_tab`, `open_tab`, `close_tab`. Still absent by design:
any action that executes a model-supplied string as code.

#### False-confirmation traps closed during review

An internal review of this increment found several ways the system could still
claim success it had not earned. Each now has a regression test:

| Defect | Why it mattered |
|---|---|
| `hasSubmissionEvidence` matched whole-page text | A sidebar rail reading "Application sent 2 days ago" for a *different* job, or a step counter reading "Application complete 3 of 5", marked the current job submitted. Patterns are now anchored and disqualified by nearby context. |
| Any text change confirmed a click | A ticking relative timestamp or a lazy-loaded rail "confirmed" a dead click. A **structural** change (url, title, modal, control/field counts, errors) is now required; the fingerprint also strips self-changing text. |
| `select` on a radio group ignored `value` | A group is published as one element whose id is its *first* option, so answering "No" to a visa question selected "Yes" — and reported `ACTION_CONFIRMED`. `select` now resolves the requested option by label or value. |
| `type` on a `<select>` threw `Illegal invocation` | Aborted the entire run. `type` now routes selects to `select` and rejects untypeable elements; `dispatch` is also wrapped so no executor throw can end a job. |
| `key_press` returned `success: true` on no effect | Also reset the stuck-loop counter, letting a model alternate click/key_press until `maxTurns`. Now `ACTION_NO_EFFECT`; `wait` is marked neutral so it neither counts as progress nor as failure. |
| Two unlabelled fields re-resolved to each other | Typed into the wrong field and verified it. Nameless controls now require positional identity. |
| `double_click` was executed as a single click | Silently wrong for any control needing a real double click. |
| Diagnostics walked and *registered* elements | Leaked detached nodes into the live registry on every failure; now a read-only `describeAll`. |
| Concurrent diagnostic writes clobbered each other | Records were lost during exactly the burst of failures they exist to explain; writes are now serialized. |

#### Tests

`npm test` runs **196** tests (52 original + 144 new), all passing:
`tests/interaction-core.test.js` (verdict logic), `tests/browser-actions.test.js`
(schema and safety), `tests/executor-dom.test.js`, `tests/adapters.test.js` and
`tests/agent-loop.test.js` (the real content scripts against a small DOM
harness in `tests/helpers/`, no jsdom dependency).

`tests/adapters.test.js` loads each adapter through the **manifest's own**
script list, so a load-order or missing-file regression fails the suite.
`tests/interaction-core.test.js` asserts the classic-script bridge and the ES
module agree, so the two copies of the verdict logic cannot drift.
