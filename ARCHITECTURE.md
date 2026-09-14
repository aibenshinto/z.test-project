
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
