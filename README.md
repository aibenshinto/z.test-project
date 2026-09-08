# AutoApply

Resume-driven job search and auto-application Chrome extension (MV3).
Target sites: Naukri (first), LinkedIn, Indeed.

## Status

| Component | State |
|---|---|
| Manifest / project layout | done |
| Provider-agnostic LLM layer (Claude / OpenAI / Gemini) | done |
| Storage + settings | done |
| Answer bank (cache-first screening answers) | done |
| Rate governor + kill switch | done |
| Orchestrator service worker | done |
| Naukri selectors | verified against live DOM 2026-09-08 |
| Naukri scrape adapter | done - parsing validated on 20 live cards |
| Naukri apply driver | done - logic tested, **real submission untested** |
| Side panel UI | done |

## Test results (2026-09-08)

| Test | Result |
|---|---|
| `classify()` vs 7 real question strings | PASS - all routed correctly |
| `typeInto()` short value ("2") | PASS - value set, input events fired |
| `typeInto()` 65-char headline | PASS - 67 input events, one per char |
| `typeInto()` overwrite | PASS - clean replace, no append |
| `parseCard()` on live results page | PASS - 20/20 cards, null salary handled |
| **End-to-end real submission** | **BLOCKED - see below** |

### Why the submission test is blocked

Two independent blockers, neither of which is a code problem:

1. The Naukri account's profile is incomplete (no resume on file, no 50+ char
   headline). Naukri refuses every application, automated or manual, until
   that is fixed. The driver correctly detects this and halts.
2. No resume file has been supplied to the extension, so the profile cannot be
   completed automatically either.

`typeInto()` is verified against a synthetic contenteditable that mirrors
Naukri's `.textArea`, including an input-event listener standing in for React's
onChange. What remains unverified is whether Naukri's own React handler accepts
those synthetic events - that can only be established on a real application.

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
4. Define searches, run in read-only mode, verify the queue looks sane.
5. Only then flip `governor.enabled`.

Your API key lives in `chrome.storage.local` and is readable by anyone with
devtools access on this machine. Fine for a personal unpacked extension; do not
publish to the Web Store with a key baked in.
