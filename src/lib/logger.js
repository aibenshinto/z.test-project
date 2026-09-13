// Structured event log. Never write API keys, resume bytes, or passwords.

import { get, set } from "./storage.js";

const KEY = "eventLog";
const MAX = 400;

const REDACT = /api[_-]?key|authorization|bearer\s+\S+|sk-[a-z0-9]+|resume.{0,8}b64/gi;

export function redact(s) {
  return String(s ?? "").replace(REDACT, "[redacted]");
}

export async function logEvent(level, message, extra = {}) {
  const row = {
    at: Date.now(),
    level,
    message: redact(message),
    extra: JSON.parse(redact(JSON.stringify(extra && typeof extra === "object" ? extra : {}))),
  };
  const log = await get(KEY, []);
  log.unshift(row);
  await set(KEY, log.slice(0, MAX));
  const line = `[${new Date(row.at).toLocaleTimeString()}] ${message}`;
  if (level === "error") console.warn(line, extra);
  else console.debug(line, extra);
  return row;
}

export const info = (m, e) => logEvent("info", m, e);
export const warn = (m, e) => logEvent("warn", m, e);
export const error = (m, e) => logEvent("error", m, e);

export async function getLog(limit = 80) {
  const log = await get(KEY, []);
  return log.slice(0, limit);
}
