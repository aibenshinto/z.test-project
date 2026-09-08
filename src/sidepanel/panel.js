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
  showCheck(p);
}

$("pHeadline").oninput = () => {
  const n = $("pHeadline").value.length;
  $("pHeadlineLen").textContent = `${n} characters${n < 50 ? " — needs 50+" : " ✓"}`;
};

function readProfileForm() {
  return {
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
  const p = readProfileForm();
  try { await setProfile(p); log("profile saved"); }
  catch (e) { log(e.message); }
  showCheck(p); loadSetup();
};

// ---- jobs ----------------------------------------------------------------
$("scrape").onclick = async () => {
  const url = $("searchUrl").value.trim();
  if (!url) return log("enter a search URL");
  log("scraping…");
  const r = await chrome.runtime.sendMessage({ type: "SCRAPE", url });
  log(r && r.ok ? `queued ${r.added} new (${r.seen} seen)` : `scrape failed: ${r && r.error}`);
  renderQueue();
};

$("clearQueue").onclick = async () => { await set("queue", []); renderQueue(); log("queue cleared"); };

async function renderQueue() {
  const q = await get("queue", []);
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

$("clearHalt").onclick = async () => {
  await chrome.storage.local.remove(["haltedAt", "haltReason"]);
  log("halt cleared"); renderStatus();
};

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

loadSetup(); loadGov(); renderStatus();
setInterval(renderStatus, 5000);
