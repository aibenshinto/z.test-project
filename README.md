# AutoApply

A Chrome extension (MV3) that applies to jobs with you, in the tab you are
already looking at. You sign in, open a page — a job search, a company's
careers page, a single job — write what you want done, and press Take over.
The agent works while you watch.

It has no per-site code and no rules for what a page is. Before every step the
model is shown the page — its text, its interactive elements and a screenshot —
and says what it is looking at: a list of jobs, one job, an application form,
a confirmation, a sign-in wall. The agent acts on that reading, so it works on
Naukri, LinkedIn, Indeed, a company careers page or an ATS it has never seen.

## Status

| Component | State |
|---|---|
| Manifest / project layout | done |
| Provider-agnostic LLM layer (Claude / OpenAI / Gemini) | done |
| Storage + settings | done |
| Answer bank (cache-first screening answers) | done |
| Rate governor + kill switch | done |
| Takeover session (the agent works your tab) | done — the run lives in the worker, so page navigation does not end it |
| Page reading (list / job / form / confirmation) | done — by the model, from the page's text, elements and a screenshot |
| Apply driver (dialog, form, external ATS, new tab) | done |
| Side panel UI | done |
| Applications embedded in an ATS iframe | done — the worker drives the frame |
| Tests | `npm test` — 281 passing |

## How a run goes

```
you sign in, open a page, write an instruction   (the agent never logs in for you)
        ↓  press Take over
read the page: list? job? form? other?           page-agent.js — the model decides
        ↓
list  → check each job against your profile      the worker, with the model
      → open it (a new tab, or in place)
job   → click the Apply the model pointed at
form  → fill it                                  the shared agent loop
done  → verify on the page itself                code, not the model
other → one step toward the instruction          e.g. a Careers link
        ↓
back to the results → next job → next page       takeover-driver.js, in the worker
```

## What it will not do

**No automated login.** The extension runs inside your already-authenticated
browser session; content scripts inherit your cookies. Scripting a login form is
the fastest way to trigger a checkpoint and get the account flagged. A sign-in
wall ends the run and leaves the page for you.

**No CAPTCHA solving.** A challenge halts the run.

**No claimed submissions.** `submitted: true` requires proof on the page: a
confirmation in words, or the apply control itself reporting the application.
The model saying it finished is never enough.

## Design notes

**No automated login.** The extension runs inside your already-authenticated
browser session; content scripts inherit your cookies. Scripting a login form is
the fastest way to trigger a checkpoint and get the account flagged.

**No vendor lock-in.** All model calls go through `askJSON()` in
`src/lib/llm/index.js`. Adapters for Claude, OpenAI and Gemini implement the same
contract. Providers are configured per task in settings, so you can route resume
parsing to one model and screening questions to another. Raw `fetch` throughout -
three SDKs would mean a bundler for no benefit.

**Nothing lives in module scope.** The MV3 service worker is evicted after ~30s
idle. All state is in `chrome.storage`. The one exception is a takeover in
progress, which keeps the worker awake while it lasts.

**Cache before you call.** ~90% of screening questions repeat across
applications. `answer-bank.js` checks the cache first and only reaches an LLM on
a genuine miss, which keeps running cost near zero and answers consistent.

**The governor is not optional.** Every submit passes `canSubmit()`: daily cap,
hourly cap, randomized delay, relevance floor, and a breaker that halts the whole
run on anything resembling a CAPTCHA or rate limit. Master switch defaults off.

## Setup

1. `chrome://extensions` -> Developer mode -> Load unpacked -> this directory.
2. Open the side panel, add an API key for at least one provider.
3. Upload your resume. It is parsed once into a structured profile.
4. Open a job board, sign in, and run a search.
5. Press **Take over this page** and watch. Stop it whenever you like.

Your API key lives in `chrome.storage.local` and is readable by anyone with
devtools access on this machine. Fine for a personal unpacked extension; do not
publish to the Web Store with a key baked in.
