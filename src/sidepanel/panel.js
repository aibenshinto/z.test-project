import { getSettings, patchSettings, get, set } from "../lib/storage.js";
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
    if (b.dataset.tab === "jobs") renderQueue();
    if (b.dataset.tab === "profile") loadProfile();
    if (b.dataset.tab === "run") renderRun();
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
  // Point every task at the chosen provider.
  for (const k of Object.keys(st.llm.routes)) {
    st.llm.routes[k].provider = p;
    st.llm.routes[k].model = $("model").value.trim() || st.llm.routes[k].model;
  }
  await patchSettings({ llm: st.llm });
  log(`provider set to ${p}`);
  loadSetup();
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
  $("pHeadlineLen").textContent = `${n} characters${n < 50 ? " — needs 50+" : " ✓"}`;
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
  $("profileCheck").textContent = c.ok
    ? "Profile is valid — applications are unblocked."
    : "Blocked: " + c.problems.join("; ");
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
  if (saved) {
    const pending = await chrome.runtime.sendMessage({ type: "PROFILE_UPDATED" });
    if (pending?.pending) {
      $("profileGuidance").hidden = false;
      $("profileGuidance").textContent = pending.suggested
        ? "Profile saved. The paused application now has a suggested answer; return to Run and confirm it."
        : "Profile saved. The paused application still needs an explicit answer; return to Run to provide it.";
      await renderRun();
    }
  }
};

$("deleteData").onclick = async () => {
  if (!confirm("Delete the resume, profile, answers, application history, logs, and API keys stored by this extension?")) return;
  await chrome.runtime.sendMessage({ type: "DELETE_DATA" });
  log("all extension data deleted");
  await loadSetup();
  await loadProfile();
  await renderQueue();
  await renderRun();
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

// ---- jobs ----------------------------------------------------------------
$("scrape").onclick = async () => {
  const url = $("searchUrl").value.trim();
  if (!url) return log("enter a search URL");
  log("scraping…");
  const r = await chrome.runtime.sendMessage({ type: "SCRAPE", url });
  log(r && r.ok
    ? `added ${r.added} profile-matched jobs (${r.review} review, ${r.filtered} filtered out, ${r.duplicate} already known)`
    : `scrape failed: ${r && r.error}`);
  renderQueue();
};

$("clearQueue").onclick = async () => { await set("queue", []); renderQueue(); log("queue cleared"); };

function listDetail(label, values) {
  const items = (values || []).filter(Boolean);
  return items.length
    ? `<div><b>${esc(label)}</b><ul>${items.map((value) => `<li>${esc(value)}</li>`).join("")}</ul></div>`
    : "";
}

function jobUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch { return ""; }
}

function queueCard(job) {
  const evaluation = job.evaluation || {};
  const reasons = evaluation.reasons?.length ? evaluation.reasons : (job.result?.reason ? [job.result.reason] : []);
  const decision = evaluation.decision || job.status || "UNKNOWN";
  const applicationReason = job.error || job.result?.reason ||
    (["needs_review", "blocked", "error"].includes(job.status)
      ? "No diagnostic was stored by the earlier extension version. Retry after reloading to capture the exact site reason."
      : "");
  const applicationAttempted = Boolean(job.result) || ["needs_review", "blocked", "error", "waiting_for_user", "submitted"].includes(job.status);
  const url = jobUrl(job.url);
  return `<details class="card">
    <summary><b>${esc(job.title)}</b> — ${esc(job.company || "Unknown company")}
      <div class="meta">${esc(job.experience || "Experience not listed")} · ${esc(job.location || "Location not listed")}</div>
      <div class="meta"><span class="pill">${esc(job.status)}</span>
      ${job.match_score != null ? `<span class="pill">match ${esc(job.match_score)}%</span>` : ""}
      <span class="pill">decision ${esc(decision)}</span></div>
    </summary>
    <div class="detail">
      <div><b>Why this decision</b></div>
      ${listDetail("Reasons", reasons) || `<div class="meta">No detailed reason was recorded for this job.</div>`}
      ${listDetail("Missing requirements", evaluation.missing_requirements)}
      ${listDetail("Risk flags", evaluation.risk_flags)}
      ${applicationAttempted ? `<div><b>Application outcome</b></div>
      <div class="meta">Status: ${esc(job.status)}</div>
      ${applicationReason ? listDetail("Reason application could not continue", [applicationReason]) : `<div class="meta">No failure reason was supplied by the platform.</div>`}
      ${job.result?.answered?.length ? `<div class="meta">Answered fields before stopping: ${job.result.answered.length}</div>` : ""}` : ""}
      <div><b>Job details</b></div>
      <div class="meta">Posted: ${esc(job.postedOn || "Not listed")} · Salary: ${esc(job.salary || "Not listed")}</div>
      ${job.tags?.length ? `<div class="meta">Skills: ${esc(job.tags.join(", "))}</div>` : ""}
      ${job.summary ? `<div class="meta" style="margin-top:5px">${esc(job.summary)}</div>` : ""}
      ${url ? `<div style="margin-top:7px"><a href="${esc(url)}" target="_blank" rel="noreferrer">Open original job listing</a></div>` : ""}
    </div>
  </details>`;
}

async function renderQueue() {
  // Existing installations may have old SKIP entries. They belong to neither
  // the actionable queue nor the review list and are hidden until the next
  // scrape removes them from storage.
  const q = (await get("queue", [])).filter((job) => job.status !== "skipped");
  $("queueOut").innerHTML = q.length
    ? q.slice(0, 40).map(queueCard).join("")
    : `<div class="meta">Queue is empty.</div>`;
  return;
  $("queueOut").innerHTML = q.length
    ? q.slice(0, 40).map((j) => `
        <div class="card">
          <b>${esc(j.title)}</b> — ${esc(j.company || "")}
          <div class="meta">${esc(j.experience || "")} · ${esc(j.location || "")} · ${esc(j.postedOn || "")}</div>
          <div class="meta"><span class="pill">${esc(j.status)}</span>
          ${j.relevance != null ? `<span class="pill">fit ${j.relevance.toFixed(2)}</span>` : ""}
          ${j.result && j.result.reason ? `<span class="pill">${esc(j.result.reason.slice(0, 40))}</span>` : ""}</div>
        </div>`).join("")
    : `<div class="meta">Queue is empty.</div>`;
}

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

$("start").onclick = async () => {
  const { governor } = await getSettings();
  await patchSettings({ governor: { ...governor, enabled: true } });
  await chrome.runtime.sendMessage({ type: "START" });
  log("run started"); renderStatus();
};

$("stop").onclick = async () => {
  const { governor } = await getSettings();
  await patchSettings({ governor: { ...governor, enabled: false } });
  await chrome.runtime.sendMessage({ type: "STOP" });
  log("run stopped"); renderStatus();
};

$("pause").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "PAUSE" });
  log("run paused"); renderRun(); renderStatus();
};

$("resume").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "RESUME" });
  log("run resumed"); renderRun(); renderStatus();
};

async function renderRun() {
  const r = await chrome.runtime.sendMessage({ type: "GET_SESSION" });
  if (!r || !r.ok) return;
  const s = r.session || {};
  const job = (r.queue || []).find((j) => j.id === s.jobId);
  const title = job ? `${esc(job.title)} — ${esc(job.company || "")}` : "No active application.";
  const failureReason = s.lastError || job?.error || job?.result?.reason || "";
  $("currentRun").innerHTML = `<b>${title}</b><div class="meta">${esc(s.state || "IDLE")} · ${esc(s.progress?.action || "idle")}${job?.match_score != null ? ` · match ${job.match_score}%` : ""}</div>${failureReason ? `<div class="meta" style="margin-top:5px;color:var(--err)">Reason: ${esc(failureReason)}</div>` : ""}`;
  const pending = s.pendingQuestion;
  const needsInput = s.state === "WAITING_FOR_USER" || s.state === "BLOCKED";
  $("actionRequired").hidden = !needsInput;
  if (needsInput) {
    $("pendingQuestion").textContent = pending?.question || pending?.reason || s.lastError || "Your input is required.";
    $("pendingAnswer").value = pending?.suggested || "";
    const permissionRequest = pending?.kind === "external_permission";
    const answerHidden = pending?.kind === "blocked" || permissionRequest;
    $("pendingAnswer").hidden = answerHidden;
    $("pendingAnswerLabel").hidden = answerHidden;
    $("answerReuseNote").hidden = answerHidden;
    const stopReason = pending?.reason && pending.reason !== pending.question ? pending.reason : "";
    $("pendingReason").hidden = !stopReason;
    $("pendingReason").textContent = stopReason ? `Why we paused: ${stopReason}` : "";
    $("continueAnswer").hidden = pending?.kind === "blocked" || permissionRequest;
    $("enableExternal").hidden = !permissionRequest;
    const hint = pending?.profileHint;
    $("editProfile").hidden = !hint || pending?.kind === "blocked" || permissionRequest;
    $("profilePrompt").hidden = !hint || pending?.kind === "blocked" || permissionRequest;
    if (hint) $("profilePrompt").textContent = `Complete profile: ${hint.help || hint.label}`;
  } else {
    $("editProfile").hidden = true;
    $("enableExternal").hidden = true;
    $("profilePrompt").hidden = true;
    $("pendingReason").hidden = true;
  }
  $("log").textContent = (r.log || []).map((e) =>
    `${new Date(e.at).toLocaleTimeString()}  ${e.level.toUpperCase()}  ${e.message}${e.extra?.reason ? ` — ${e.extra.reason}` : ""}`).join("\n");
}

$("continueAnswer").onclick = async () => {
  const answer = $("pendingAnswer").value.trim();
  if (!answer) return log("enter an answer first");
  const r = await chrome.runtime.sendMessage({ type: "USER_ANSWER", answer });
  log(r?.ok ? "answer saved for future matching questions; continuing application" : `could not continue: ${r?.error || "unknown error"}`);
  renderRun();
};

$("editProfile").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: "GET_SESSION" });
  const hint = r?.session?.pendingQuestion?.profileHint;
  if (!hint?.fieldId) return;
  $("profileGuidance").hidden = false;
  $("profileGuidance").textContent = `Application paused: ${hint.help || `complete ${hint.label}`}`;
  document.querySelector('nav button[data-tab="profile"]').click();
  await loadProfile();
  requestAnimationFrame(() => {
    const field = $(hint.fieldId);
    field?.focus();
    field?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
};

$("enableExternal").onclick = async () => {
  const result = await chrome.runtime.sendMessage({ type: "ENABLE_EXTERNAL_SITE" });
  log(result?.ok ? "company-site permission granted; continuing application" : `company-site permission not granted: ${result?.error || "unknown error"}`);
  renderRun();
  renderQueue();
};

$("skipJob").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "SKIP_JOB" });
  log("application skipped"); renderRun();
};

$("clearHalt").onclick = async () => {
  await chrome.storage.local.remove(["haltedAt", "haltReason"]);
  log("halt cleared"); renderStatus();
};

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

loadSetup(); loadGov(); renderStatus(); renderRun();
setInterval(() => { renderStatus(); renderRun(); }, 5000);
