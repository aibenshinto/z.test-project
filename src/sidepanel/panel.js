import { getSettings, patchSettings } from "../lib/storage.js";
import { encodeFile, storeResume, parseResume, getProfile, getResume,
         setProfile, validateProfile } from "../lib/resume.js";
import { exportBank, remember } from "../lib/answer-bank.js";

const $ = (id) => document.getElementById(id);
const log = (m) => { $("log").textContent = `${new Date().toLocaleTimeString()}  ${m}\n` + $("log").textContent; };

// ---- tabs ----------------------------------------------------------------
document.querySelectorAll("nav button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll("nav button").forEach((x) => x.setAttribute("aria-selected", x === b));
    document.querySelectorAll("section").forEach((s) => (s.hidden = s.id !== "tab-" + b.dataset.tab));
    if (b.dataset.tab === "answers") renderBank();
    if (b.dataset.tab === "profile") loadProfile();
  };
});

// ---- status --------------------------------------------------------------
async function renderStatus() {
  const s = await chrome.runtime.sendMessage({ type: "STATS" });
  const el = $("status");
  if (!s) return;
  el.classList.toggle("halted", Boolean(s.halted));
  el.textContent = s.halted
    ? `HALTED — ${s.haltReason || "unknown"}`
    : `${s.today} applied today · ${s.lastHour} this hour`;
}

// ---- setup ---------------------------------------------------------------
async function loadSetup() {
  const st = await getSettings();
  const p = st.llm.routes.default.provider;
  $("provider").value = p;
  $("apiKey").value = st.llm.keys[p] || "";
  $("model").value = st.llm.routes.default.model || "";
  $("keyHint").textContent = { gemini: "aistudio.google.com", claude: "console.anthropic.com", openai: "platform.openai.com" }[p] || "";
  // UI Agent route
  const uiRoute = st.llm.routes.uiAction || {};
  if ($("uiProvider")) $("uiProvider").value = uiRoute.provider || "gemini";
  if ($("uiModel")) {
    const m = uiRoute.model || "gemini-2.0-flash";
    const opt = $("uiModel").querySelector(`option[value="${m}"]`);
    if (opt) $("uiModel").value = m;
  }
  const prof = await getProfile();
  const res = await getResume();
  $("profileOut").textContent = prof
    ? `${prof.fullName} · ${prof.currentTitle} · ${prof.totalYears}y · ${(prof.skills || []).length} skills`
    : res ? `${res.name} uploaded — not parsed yet` : "No resume uploaded.";
}

$("provider").onchange = loadSetup;

$("saveKey").onclick = async () => {
  const st = await getSettings();
  const p = $("provider").value;
  st.llm.keys[p] = $("apiKey").value.trim();
  // Point every task at the chosen provider -- EXCEPT uiAction which has its own control.
  for (const k of Object.keys(st.llm.routes)) {
    if (k === "uiAction") continue;
    st.llm.routes[k].provider = p;
    st.llm.routes[k].model = $("model").value.trim() || st.llm.routes[k].model;
  }
  await patchSettings({ llm: st.llm });
  log(`provider set to ${p}`);
  loadSetup();
};

$("saveUiAgent").onclick = async () => {
  const st = await getSettings();
  const p = $("uiProvider").value;
  const m = $("uiModel").value;
  if (!st.llm.routes.uiAction) st.llm.routes.uiAction = {};
  st.llm.routes.uiAction.provider  = p;
  st.llm.routes.uiAction.model     = m;
  st.llm.routes.uiAction.maxTokens = 2048;
  await patchSettings({ llm: st.llm });
  const hint = $("uiAgentStatus");
  hint.textContent = `✓ UI agent set to ${p} / ${m}`;
  setTimeout(() => { hint.textContent = ""; }, 3000);
  log(`UI agent set to ${p} / ${m}`);
};

$("uploadResume").onclick = async () => {
  const f = $("resumeFile").files[0];
  if (!f) return log("pick a file first");
  // File cannot cross sendMessage; encode here in the panel.
  const enc = await encodeFile(f);
  await storeResume(enc);
  log(`stored ${enc.name} (${Math.round(enc.bytes / 1024)} kB)`);
  loadSetup();
};

$("parseResume").onclick = async () => {
  log("parsing resume…");
  try {
    const p = await parseResume();
    log(`parsed: ${p.fullName}, ${p.totalYears}y, ${(p.skills || []).length} skills`);
    loadSetup();
  } catch (e) { log("parse failed: " + e.message); }
};

// ---- profile --------------------------------------------------------------
async function loadProfile() {
  const p = (await getProfile()) || {};
  $("pName").value = p.fullName || ""; $("pTitle").value = p.currentTitle || "";
  $("pHeadline").value = p.headline || ""; $("pLocation").value = p.location || "";
  $("pYears").value = p.totalYears != null ? p.totalYears : "";
  $("pPreferred").value = (p.preferredLocations || []).join(", ");
  $("pSkills").value = (p.skills || []).map((s) => `${s.name}: ${s.years}`).join("\n");
  $("pEmail").value = p.email || ""; $("pPhone").value = p.phone || "";
  $("pNotice").value = p.noticePeriodDays != null ? p.noticePeriodDays : "";
  $("pRemote").value = p.remotePreference || "";
  $("pWorkAuth").value = p.workAuthorization || "";
  $("pVisa").value = p.visaSponsorship || "";
  $("pCurrentSalary").value = p.currentSalary || "";
  $("pSalaryExpectation").value = p.salaryExpectation || "";
  $("pRelocate").checked = p.willingToRelocate === true;
  const { preferences: pref } = await getSettings();
  $("prefTitles").value = (pref.jobTitles || []).join(", ");
  $("prefLocations").value = (pref.locations || []).join(", ");
  $("prefAnywhereIndia").checked = pref.applyAnywhereInIndia === true;
  $("prefExpMin").value = pref.experienceRange?.min ?? "";
  $("prefExpMax").value = pref.experienceRange?.max ?? "";
  $("prefEmployment").value = (pref.employmentTypes || []).join(", ");
  $("prefExcludeCompanies").value = (pref.companiesToExclude || []).join(", ");
  $("prefIncludeKeywords").value = (pref.keywordsToInclude || []).join(", ");
  $("prefExcludeKeywords").value = (pref.keywordsToExclude || []).join(", ");
  showCheck(p);
}

const csv = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);

$("pHeadline").oninput = () => {
  const n = $("pHeadline").value.length;
  $("pHeadlineLen").textContent = `${n} characters${n < 50 ? " — some boards expect 50+" : " ✓"}`;
};

async function readProfileForm() {
  // Preserve parsed education, projects, links, and other fields the compact
  // editor does not display. Saving a small correction must not erase them.
  const existing = (await getProfile()) || {};
  return {
    ...existing,
    fullName: $("pName").value.trim(),
    currentTitle: $("pTitle").value.trim(),
    headline: $("pHeadline").value.trim(),
    location: $("pLocation").value.trim(),
    totalYears: parseFloat($("pYears").value) || 0,
    preferredLocations: $("pPreferred").value.split(",").map((s) => s.trim()).filter(Boolean),
    skills: $("pSkills").value.split("\n").map((line) => {
      const [name, years] = line.split(":");
      if (!name || !name.trim()) return null;
      return { name: name.trim(), years: parseFloat(years) || 0 };
    }).filter(Boolean),
    email: $("pEmail").value.trim(),
    phone: $("pPhone").value.trim(),
    noticePeriodDays: $("pNotice").value === "" ? undefined : Number($("pNotice").value),
    remotePreference: $("pRemote").value,
    workAuthorization: $("pWorkAuth").value.trim(),
    visaSponsorship: $("pVisa").value.trim(),
    currentSalary: $("pCurrentSalary").value.trim(),
    salaryExpectation: $("pSalaryExpectation").value.trim(),
    willingToRelocate: $("pRelocate").checked,
  };
}

function showCheck(p) {
  const c = validateProfile(p);
  const warnings = (c.warnings || []).join("; ");
  $("profileCheck").textContent = !c.ok
    ? "Blocked: " + c.problems.join("; ")
    : warnings
      ? `Profile is valid — applications are unblocked. Worth fixing: ${warnings}.`
      : "Profile is valid — applications are unblocked.";
  $("profileCheck").style.color = c.ok ? "var(--ok)" : "var(--warn)";
}

$("loadSeed").onclick = async () => {
  const seed = await fetch(chrome.runtime.getURL("profile.seed.json")).then((r) => r.json());
  $("pName").value = seed.fullName; $("pTitle").value = seed.currentTitle;
  $("pHeadline").value = seed.headline; $("pLocation").value = seed.location;
  $("pYears").value = seed.totalYears;
  $("pPreferred").value = (seed.preferredLocations || []).join(", ");
  $("pSkills").value = (seed.skills || []).map((s) => `${s.name}: ${s.years}`).join("\n");
  $("pHeadline").dispatchEvent(new Event("input"));
  showCheck(seed);
  log("seed loaded — review, then Save profile");
};

$("saveProfile").onclick = async () => {
  const p = await readProfileForm();
  let saved = false;
  try { await setProfile(p); saved = true; log("profile saved"); }
  catch (e) { log(e.message); }
  showCheck(p); loadSetup();
  if (saved) log("profile saved");
};

$("deleteData").onclick = async () => {
  if (!confirm("Delete the resume, profile, answers, application history, logs, and API keys stored by this extension?")) return;
  await chrome.runtime.sendMessage({ type: "DELETE_DATA" });
  log("all extension data deleted");
  await loadSetup();
  await loadProfile();
};

$("savePreferences").onclick = async () => {
  const { preferences } = await getSettings();
  const min = $("prefExpMin").value;
  const max = $("prefExpMax").value;
  await patchSettings({ preferences: {
    ...preferences,
    jobTitles: csv($("prefTitles").value),
    locations: csv($("prefLocations").value),
    applyAnywhereInIndia: $("prefAnywhereIndia").checked,
    experienceRange: {
      min: min === "" ? 0 : Number(min),
      max: max === "" ? 10 : Number(max),
    },
    employmentTypes: csv($("prefEmployment").value),
    companiesToExclude: csv($("prefExcludeCompanies").value),
    keywordsToInclude: csv($("prefIncludeKeywords").value),
    keywordsToExclude: csv($("prefExcludeKeywords").value),
  }});
  log("preferences saved");
};

// ---- answers -------------------------------------------------------------
async function renderBank() {
  const bank = await exportBank();
  const keys = Object.keys(bank);
  $("bankOut").innerHTML = keys.length
    ? keys.map((k) => `
        <div class="card">
          <div class="meta">${esc(bank[k].question || k)}</div>
          <input data-k="${esc(k)}" value="${esc(bank[k].answer)}">
          <div class="meta"><span class="pill">${esc(bank[k].source)}</span></div>
        </div>`).join("")
    : `<div class="meta">No cached answers yet.</div>`;
  $("bankOut").querySelectorAll("input").forEach((i) => {
    i.onchange = async () => {
      const bank2 = await exportBank();
      await remember(bank2[i.dataset.k].question || i.dataset.k, i.value, { source: "user" });
      log("answer updated");
    };
  });
}

// ---- run -----------------------------------------------------------------

/** What the agent has been doing, from the worker's own event log. */
async function renderActivity() {
  const r = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (!r?.ok) return;
  $("log").textContent = (r.log || []).map((e) =>
    `${new Date(e.at).toLocaleTimeString()}  ${e.level.toUpperCase()}  ${e.message}` +
    `${e.extra?.reason ? ` — ${e.extra.reason}` : ""}`).join("\n");
}

async function loadGov() {
  const { governor: g } = await getSettings();
  $("maxPerDay").value = g.maxPerDay; $("maxPerHour").value = g.maxPerHour;
  $("minDelay").value = g.minDelayMs / 1000; $("maxDelay").value = g.maxDelayMs / 1000;
  $("minRelevance").value = g.minRelevance;
}

$("saveGov").onclick = async () => {
  const { governor } = await getSettings();
  await patchSettings({ governor: { ...governor,
    maxPerDay: +$("maxPerDay").value, maxPerHour: +$("maxPerHour").value,
    minDelayMs: +$("minDelay").value * 1000, maxDelayMs: +$("maxDelay").value * 1000,
    minRelevance: +$("minRelevance").value } });
  log("limits saved");
};

$("clearHalt").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_HALT" });
  log("halt cleared"); renderStatus();
};

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------------------
// Agent takeover — the agent works the tab the user is already looking at
// ---------------------------------------------------------------------------

/** The tab the user is looking at, which is the one the agent takes over. */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

/** Ask the page what pressing Take over would do, so the button can say so. */
async function renderTakeoverContext() {
  const box = $("takeoverContext");
  if (!box) return;

  const tab = await activeTab();
  if (!tab?.id) { box.textContent = "No active tab."; return; }

  let probe = null;
  try {
    probe = await chrome.tabs.sendMessage(tab.id, { type: "TAKEOVER_PROBE" });
  } catch (_) {
    // The content script is not in this tab — a chrome:// page, the web store,
    // or a tab opened before the extension was loaded.
    box.innerHTML = `<span style="color:var(--err)">The agent cannot run on this page.</span>` +
      ` Open a job search on a normal website and reload it.`;
    return;
  }

  if (!probe?.ok) { box.textContent = "Could not read this page."; return; }

  const host = (() => { try { return new URL(probe.url).hostname; } catch (_) { return probe.url; } })();
  box.innerHTML = probe.onResultsPage
    ? `Ready on <b>${esc(host)}</b> — <b>${probe.jobCount}</b> job${probe.jobCount === 1 ? "" : "s"} visible.`
    : `On <b>${esc(host)}</b>. No results list detected; the agent will apply to this single job.`;
}

function setTakeoverRunning(running) {
  $("takeoverStart").hidden = running;
  $("takeoverPause").hidden = !running;
  $("takeoverStop").hidden = !running;
  $("takeoverResume").hidden = true;
}

if ($("takeoverStart")) {
  $("takeoverStart").onclick = async () => {
    const tab = await activeTab();
    if (!tab?.id) return log("no active tab");

    setTakeoverRunning(true);
    $("takeoverStatus").textContent = "Agent has taken over the page…";
    log(`agent taking over: ${tab.title || tab.url}`);

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "SET_CURSOR_VISIBLE",
        visible: $("showCursor").checked,
      }).catch(() => {});

      const result = await chrome.tabs.sendMessage(tab.id, {
        type: "TAKEOVER_START",
        options: {
          maxJobs: Number($("maxJobs").value) || 25,
          maxPages: Number($("maxPages").value) || 3,
        },
      });

      if (!result?.ok) {
        $("takeoverStatus").textContent = `Stopped: ${result?.error || "unknown error"}`;
      } else {
        const parts = [`${result.appliedCount} applied`, `${result.skippedCount} skipped`];
        if (result.reason) parts.push(esc(result.reason));
        $("takeoverStatus").innerHTML =
          `<b>${parts.slice(0, 2).join(", ")}</b><div>${esc(result.reason || "")}</div>` +
          renderJobList(result.applied, "Applied") +
          renderJobList(result.skipped, "Not submitted");
      }
    } catch (err) {
      // The run lives in the page's own scripts, so the page leaving takes the
      // run with it. A job board does exactly that when its apply control
      // sends the tab to the company's site or to its own record of the click.
      const message = String(err?.message || err);
      const navigatedAway =
        /message channel closed|Receiving end does not exist|context invalidated/i.test(message);
      $("takeoverStatus").textContent = navigatedAway
        ? "The page navigated away and the run stopped with it — a job board does this when " +
          "Apply sends the tab elsewhere. Jobs already applied to are recorded. Go back to the " +
          "results list and take over again to carry on."
        : `The page stopped responding: ${message}. If it navigated away, reload and take over again.`;
    } finally {
      setTakeoverRunning(false);
      renderDiagnostics();
    }
  };
}

function renderJobList(jobs, heading) {
  if (!jobs?.length) return "";
  const rows = jobs.slice(0, 25).map((j) =>
    `<div>· ${esc(j.title)}${j.company ? ` — ${esc(j.company)}` : ""}` +
    `${j.reason ? `<br><span style="opacity:.75">${esc(j.reason)}</span>` : ""}</div>`).join("");
  return `<div style="margin-top:6px"><b>${esc(heading)}</b>${rows}</div>`;
}

for (const [id, type] of [["takeoverStop", "TAKEOVER_STOP"], ["takeoverPause", "TAKEOVER_PAUSE"], ["takeoverResume", "TAKEOVER_RESUME"]]) {
  const btn = $(id);
  if (!btn) continue;
  btn.onclick = async () => {
    const tab = await activeTab();
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, { type }).catch(() => {});
    if (type === "TAKEOVER_PAUSE") { $("takeoverPause").hidden = true; $("takeoverResume").hidden = false; }
    if (type === "TAKEOVER_RESUME") { $("takeoverPause").hidden = false; $("takeoverResume").hidden = true; }
    if (type === "TAKEOVER_STOP") { $("takeoverStatus").textContent = "Stopping after the current step…"; }
  };
}

if ($("showCursor")) {
  $("showCursor").onchange = async (event) => {
    const tab = await activeTab();
    if (!tab?.id) return;
    await chrome.tabs.sendMessage(tab.id, {
      type: "SET_CURSOR_VISIBLE", visible: event.target.checked,
    }).catch(() => {});
  };
}

// Live progress from the agent as it works.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "TAKEOVER_PROGRESS") return;
  const box = $("takeoverStatus");
  if (!box) return;
  const job = msg.job ? ` — ${esc(String(msg.job).slice(0, 60))}` : "";
  box.innerHTML = `<b>${esc(msg.phase || "")}</b>${job}<div>${esc(msg.note || "")}</div>`;
});

// ---------------------------------------------------------------------------
// Interaction diagnostics
// ---------------------------------------------------------------------------

/**
 * Render the recent interaction records so a failed click can be diagnosed:
 * what was clicked, by which method, and whether the site actually reacted.
 */
async function renderDiagnostics() {
  const box = $("diagnostics");
  if (!box) return;

  const r = await chrome.runtime.sendMessage({ type: "GET_DIAGNOSTICS", limit: 25 });
  if (!r?.ok) { box.textContent = "could not load diagnostics"; return; }

  $("debugMode").checked = Boolean(r.debug);

  if (!r.diagnostics.length) {
    box.textContent = "No interactions recorded yet.";
    return;
  }

  const rows = r.diagnostics.map((d) => {
    const ok = d.result === "ACTION_CONFIRMED";
    const when = new Date(d.timestamp || d.storedAt).toLocaleTimeString();
    const retries = d.retryCount ? ` after ${d.retryCount} retr${d.retryCount === 1 ? "y" : "ies"}` : "";
    const changes = d.attempts?.find((a) => a.changes?.length)?.changes?.join(", ");
    return `<div style="margin-bottom:6px;padding-left:6px;border-left:2px solid ${ok ? "#2d7" : "#d55"}">
      <div><strong>${esc(d.action)}</strong> "${esc(d.targetText || d.target || "")}"
        via ${esc(d.method)}${esc(retries)}</div>
      <div>${esc(d.result)}${changes ? ` — page changed: ${esc(changes)}` : ""}</div>
      ${d.error ? `<div>${esc(d.error)}</div>` : ""}
      <div>${esc(when)}${d.beforeState?.url ? ` · ${esc(d.beforeState.url)}` : ""}</div>
    </div>`;
  });

  const captures = r.captures?.length
    ? `<div style="margin-top:8px">Debug captures stored: ${r.captures.length}
       (${r.captures.map((c) => esc(c.id)).join(", ")})</div>`
    : "";

  box.innerHTML = rows.join("") + captures;
}

if ($("debugMode")) {
  $("debugMode").onchange = async (event) => {
    await chrome.runtime.sendMessage({ type: "SET_DEBUG_MODE", debug: event.target.checked });
    log(event.target.checked
      ? "debug capture on — screenshots will be stored for failed interactions"
      : "debug capture off");
  };
}

if ($("refreshDiagnostics")) {
  $("refreshDiagnostics").onclick = renderDiagnostics;
}

if ($("clearDiagnostics")) {
  $("clearDiagnostics").onclick = async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_DIAGNOSTICS" });
    log("diagnostics cleared");
    renderDiagnostics();
  };
}

loadSetup(); loadGov(); renderStatus(); renderActivity(); renderDiagnostics(); renderTakeoverContext();
setInterval(() => { renderStatus(); renderActivity(); }, 5000);

// Keep the takeover context in step with whatever the user is looking at.
chrome.tabs.onActivated.addListener(() => renderTakeoverContext());
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.status === "complete" && tab.active) renderTakeoverContext();
});
