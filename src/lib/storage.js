// chrome.storage.local wrapper. The MV3 service worker is evicted after ~30s
// idle, so nothing may live in module scope between events - it all goes here.

const DEFAULTS = {
  llm: {
    keys: { claude: "", openai: "", gemini: "" },
    // Provider is per task. Swap any line to "claude" or "openai" and nothing
    // else in the codebase changes - askJSON() is the only call site.
    routes: {
      default:        { provider: "gemini", model: "gemini-flash-latest", maxTokens: 4096 },
      parseResume:    { provider: "gemini", model: "gemini-flash-latest", maxTokens: 8192 },
      rankJob:        { provider: "gemini", model: "gemini-flash-latest", maxTokens: 2048 },
      answerQuestion: { provider: "gemini", model: "gemini-flash-latest", maxTokens: 1024 },
    },
  },
  profile: null,          // structured resume, produced once by parseResume
  resumeText: "",         // raw extracted text, kept for re-parsing
  governor: {
    enabled: false,       // master kill switch - off until you flip it
    maxPerDay: 25,
    maxPerHour: 8,
    minDelayMs: 30000,
    maxDelayMs: 90000,
    minRelevance: 0.65,   // skip anything the ranker scores below this
    haltOnAnomaly: true,  // stop everything on CAPTCHA / unexpected DOM
  },
  searches: [],           // [{ site, keywords, location, filters }]
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const out = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    out[k] = stored[k] === undefined ? v : stored[k];
  }
  return out;
}

export async function patchSettings(partial) {
  const current = await getSettings();
  const merged = { ...current, ...partial };
  await chrome.storage.local.set(merged);
  return merged;
}

export async function get(key, fallback = null) {
  const r = await chrome.storage.local.get(key);
  return r[key] === undefined ? fallback : r[key];
}

export const set = (key, value) => chrome.storage.local.set({ [key]: value });
