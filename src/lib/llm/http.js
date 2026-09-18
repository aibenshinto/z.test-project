// One request to a model provider, bounded in time.
//
// fetch() has no timeout of its own, so a request the provider never answers
// would hold a takeover run forever, with nothing on screen but the last
// step it reported.

export const REQUEST_TIMEOUT_MS = 90000;

/**
 * POST `body` as JSON to `url`, giving up after `timeoutMs`.
 *
 * A timeout is thrown as an error that says so, with `timeout: true`, rather
 * than as the AbortError fetch raises, which reads like a cancellation.
 */
export async function postJSON(url, headers, body, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      const timeout = new Error(`the model did not answer within ${Math.round(timeoutMs / 1000)} s`);
      timeout.timeout = true;
      throw timeout;
    }
    throw err;
  }
}
