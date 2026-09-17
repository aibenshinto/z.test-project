# AutoApply

A Chrome extension (MV3) that applies to jobs with you, in the tab you are
already looking at. You sign in and run the search you want; the agent works
down those results while you watch.

It has no per-site code. The agent reads a page by what the page offers — a
list that repeats, a control that starts an application, a form that takes a
CV — so it works on Naukri, LinkedIn, Indeed, a company careers page or an ATS
it has never seen, without anyone adding support for them first.

## Status

| Component | State |
|---|---|
| Manifest / project layout | done |
| Provider-agnostic LLM layer (Claude / OpenAI / Gemini) | done |
| Storage + settings | done |
| Answer bank (cache-first screening answers) | done |
| Rate governor + kill switch | done |
| Takeover session (the agent works your tab) | done |
| Results discovery on any board | done — by repeated structure, not per-site selectors |
| Apply driver (dialog, form, external ATS, new tab) | done |
| Side panel UI | done |
| Applications embedded in an ATS iframe | done — the worker drives the frame |
| Tests | `npm test` — 265 passing |

## How a run goes

```
you sign in and search                     (the agent never logs in for you)
        ↓  press Take over
walk the visible results                   results-walker.js
        ↓
check the job against your profile         the worker, with the model
        ↓
open it → find apply → fill → verify       takeover.js + the shared agent loop
        ↓                                   (a new tab is followed and handed back)
back to the results → next job → next page
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
idle. All state is in `chrome.storage`; the run loop is driven by `chrome.alarms`.

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
