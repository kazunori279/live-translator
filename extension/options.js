/**
 * Options: which relay to talk to, which voice, and the glossary.
 *
 * The glossary lives in `chrome.storage.local` and is sent to the relay as the
 * first message of every session, exactly as the web app sends its
 * localStorage copy. The relay never persists it, so this browser's terms stay
 * this browser's.
 */

import { BACKENDS, DEFAULTS, loadSettings, saveSettings, originPattern } from "./lib/settings.js";
import {
  MAX_GLOSSARY_BYTES,
  ensureGlossary,
  normalizeEntry,
  parseGlossaryCsv,
} from "./lib/glossary.js";

const el = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };

init();

async function init() {
  settings = await loadSettings();
  fillPresets();
  el("backendUrl").value = settings.backendUrl;
  bind();
  await Promise.all([refreshBackendStatus(), refreshMicStatus(), loadVoices()]);
  renderGlossary(await ensureGlossary(settings.backendUrl));
}

function fillPresets() {
  const select = el("preset");
  select.innerHTML = "";
  for (const [name, url] of Object.entries(BACKENDS)) {
    const opt = document.createElement("option");
    opt.value = url;
    opt.textContent = `${name} — ${url}`;
    select.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = "";
  custom.textContent = "Custom…";
  select.appendChild(custom);
  select.value = Object.values(BACKENDS).includes(settings.backendUrl)
    ? settings.backendUrl
    : "";
}

function bind() {
  el("preset").addEventListener("change", async () => {
    if (!el("preset").value) return;
    el("backendUrl").value = el("preset").value;
    await setBackend(el("preset").value);
  });
  el("backendUrl").addEventListener("change", () => setBackend(el("backendUrl").value.trim()));
  el("grant").addEventListener("click", grantBackend);
  el("grantMic").addEventListener("click", grantMic);
  el("voice").addEventListener("change", () => saveSettings({ voice: el("voice").value }));
  el("uploadGlossary").addEventListener("click", uploadGlossary);
  el("resetGlossary").addEventListener("click", resetGlossary);
}

async function setBackend(url) {
  if (!originPattern(url)) {
    el("backendStatus").textContent = "That is not a valid URL.";
    return;
  }
  settings.backendUrl = url;
  await saveSettings({ backendUrl: url });
  fillPresets();
  await refreshBackendStatus();
  await loadVoices();
}

async function refreshBackendStatus() {
  const origins = [originPattern(settings.backendUrl)].filter(Boolean);
  const granted = origins.length && (await chrome.permissions.contains({ origins }));
  el("grant").hidden = !!granted;
  el("backendStatus").textContent = granted
    ? "Access granted."
    : "Access not granted yet — Start will ask for it, or grant it here.";
  el("backendStatus").className = granted ? "note ok" : "note";
}

async function grantBackend() {
  const origins = [originPattern(settings.backendUrl)].filter(Boolean);
  if (!origins.length) return;
  await chrome.permissions.request({ origins });
  await refreshBackendStatus();
  await loadVoices();
}

/**
 * Ask for the microphone from a page that can show a prompt.
 *
 * The offscreen document where capture actually happens has no UI, so a
 * refusal there is unrecoverable from inside it. Chrome grants the microphone
 * per extension rather than per page, so a grant obtained here is the grant
 * the offscreen document will use.
 */
async function grantMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    el("micStatus").textContent = `Denied: ${err.name}`;
    el("micStatus").className = "note";
    return;
  }
  await refreshMicStatus();
}

async function refreshMicStatus() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    const granted = status.state === "granted";
    el("micStatus").textContent = granted ? "Granted." : `Not granted (${status.state}).`;
    el("micStatus").className = granted ? "note ok" : "note";
    el("grantMic").hidden = granted;
  } catch {
    el("micStatus").textContent = "";
  }
}

async function loadVoices() {
  const select = el("voice");
  try {
    const resp = await fetch(new URL("/api/languages", settings.backendUrl));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const { voices, defaultVoice } = await resp.json();
    const chosen = settings.voice || defaultVoice;
    select.innerHTML = "";
    for (const [name, tone] of Object.entries(voices || {})) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = `${name} — ${tone}`;
      if (name === chosen) opt.selected = true;
      select.appendChild(opt);
    }
    select.disabled = false;
  } catch {
    select.innerHTML = "<option>Unavailable — grant backend access first</option>";
    select.disabled = true;
  }
}

async function uploadGlossary() {
  const file = el("glossaryFile").files[0];
  const status = el("glossaryStatus");
  if (!file) return setStatus(status, "Pick a .csv file first.");
  if (!file.name.toLowerCase().endsWith(".csv")) {
    return setStatus(status, "File must have a .csv extension.");
  }
  if (file.size > MAX_GLOSSARY_BYTES) {
    return setStatus(status, `File exceeds ${MAX_GLOSSARY_BYTES} bytes.`);
  }
  try {
    const pairs = parseGlossaryCsv(await file.text()).map(normalizeEntry).filter(Boolean);
    await chrome.storage.local.set({ glossary: pairs });
    renderGlossary(pairs);
    setStatus(status, `Replaced with ${pairs.length} entries. Applies on next Start.`, true);
    el("glossaryFile").value = "";
  } catch (err) {
    setStatus(status, "Load failed: " + err.message);
  }
}

async function resetGlossary() {
  // Clearing first makes ensureGlossary re-seed from the relay rather than
  // return the copy already in storage.
  await chrome.storage.local.remove("glossary");
  const pairs = await ensureGlossary(settings.backendUrl);
  renderGlossary(pairs);
  setStatus(el("glossaryStatus"), `Reset to ${pairs.length} default entries.`, true);
}

function renderGlossary(pairs) {
  const host = el("glossaryList");
  host.innerHTML = "";
  if (!pairs.length) {
    host.innerHTML = '<p class="note" style="padding:0.5rem">No glossary entries.</p>';
    return;
  }
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const label of ["Source", "Pronunciation", "Transcript"]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const { source, target, transcription } of pairs) {
    const tr = document.createElement("tr");
    for (const value of [source, target, transcription || target]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  host.appendChild(table);
}

function setStatus(node, text, ok = false) {
  node.textContent = text;
  node.className = ok ? "note ok" : "note";
}
