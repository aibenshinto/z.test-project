// Named agent states. Pure transitions so the worker can persist a snapshot
// after every event; the MV3 service worker may be killed between ticks.

export const STATES = {
  IDLE: "IDLE",
  DISCOVERING_JOB: "DISCOVERING_JOB",
  EVALUATING_JOB: "EVALUATING_JOB",
  OPENING_APPLICATION: "OPENING_APPLICATION",
  EXTRACTING_FORM: "EXTRACTING_FORM",
  ANSWERING_FORM: "ANSWERING_FORM",
  WAITING_FOR_USER: "WAITING_FOR_USER",
  SUBMITTING: "SUBMITTING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  SKIPPED: "SKIPPED",
  BLOCKED: "BLOCKED",
  PAUSED: "PAUSED",
  STOPPED: "STOPPED",
};

const ALLOWED = {
  [STATES.IDLE]: ["DISCOVERING_JOB", "STOPPED", "PAUSED"],
  [STATES.DISCOVERING_JOB]: ["EVALUATING_JOB", "IDLE", "PAUSED", "STOPPED", "FAILED"],
  [STATES.EVALUATING_JOB]: [
    "OPENING_APPLICATION", "SKIPPED", "WAITING_FOR_USER", "PAUSED", "STOPPED", "FAILED",
  ],
  [STATES.OPENING_APPLICATION]: [
    "EXTRACTING_FORM", "BLOCKED", "FAILED", "PAUSED", "STOPPED",
  ],
  [STATES.EXTRACTING_FORM]: [
    "ANSWERING_FORM", "BLOCKED", "FAILED", "PAUSED", "STOPPED",
  ],
  [STATES.ANSWERING_FORM]: [
    "WAITING_FOR_USER", "SUBMITTING", "BLOCKED", "FAILED", "PAUSED", "STOPPED", "COMPLETED",
  ],
  [STATES.WAITING_FOR_USER]: [
    "ANSWERING_FORM", "SKIPPED", "PAUSED", "STOPPED", "FAILED", "BLOCKED",
  ],
  [STATES.SUBMITTING]: ["COMPLETED", "FAILED", "BLOCKED", "PAUSED", "STOPPED"],
  [STATES.COMPLETED]: ["DISCOVERING_JOB", "IDLE", "STOPPED"],
  [STATES.FAILED]: ["DISCOVERING_JOB", "IDLE", "STOPPED"],
  [STATES.SKIPPED]: ["DISCOVERING_JOB", "IDLE", "STOPPED"],
  [STATES.BLOCKED]: ["DISCOVERING_JOB", "IDLE", "STOPPED", "PAUSED", "WAITING_FOR_USER"],
  [STATES.PAUSED]: ["DISCOVERING_JOB", "ANSWERING_FORM", "WAITING_FOR_USER", "STOPPED", "IDLE"],
  [STATES.STOPPED]: ["IDLE", "DISCOVERING_JOB"],
};

export function emptySession() {
  return {
    state: STATES.IDLE,
    jobId: null,
    tabId: null,
    pendingQuestion: null,
    progress: { step: 0, total: 0, action: "idle" },
    paused: false,
    updatedAt: 0,
    lastError: null,
  };
}

/**
 * @param {object} session
 * @param {string} nextState  STATES.* value
 * @param {object} [patch]
 */
export function transition(session, nextState, patch = {}) {
  const current = session?.state || STATES.IDLE;
  const allowed = ALLOWED[current] || [];
  if (!allowed.includes(nextState)) {
    throw new Error(`illegal transition ${current} → ${nextState}`);
  }
  return {
    ...emptySession(),
    ...session,
    ...patch,
    state: nextState,
    paused: nextState === STATES.PAUSED ? true : nextState === STATES.STOPPED ? false : (patch.paused ?? session.paused),
    updatedAt: Date.now(),
  };
}

export function canAutoAdvance(session) {
  if (!session) return false;
  if (session.paused) return false;
  const s = session.state;
  return s !== STATES.WAITING_FOR_USER
    && s !== STATES.BLOCKED
    && s !== STATES.PAUSED
    && s !== STATES.STOPPED
    && s !== STATES.IDLE;
}
