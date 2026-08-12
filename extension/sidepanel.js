/**
 * Side panel: controls and the running transcript.
 *
 * It holds no audio and no socket, so closing it does not stop a capture — it
 * reads the current state from the service worker on open and then follows the
 * offscreen document's broadcasts. Every control writes straight to
 * `chrome.storage.local`, which is what the service worker reads when Start is
 * pressed, so the panel never has to hand its state over.
 */

import { DEFAULTS, loadSettings, saveSettings, originPattern } from "./lib/settings.js";

const el = (id) => document.getElementById(id);
const LANG_FALLBACK = { en: "English", ja: "Japanese" };

// The two models take different code sets for the same languages, so a target
// picked in one mode has to be carried across when the mode flips. Same tables
// as `app/static/js/app.js`.
const AGENT_TO_SIMUL = { zh: "zh-Hans", iw: "he", pt: "pt-BR" };
const SIMUL_TO_AGENT = { "zh-Hans": "zh", "zh-Hant": "zh", he: "iw", "pt-BR": "pt", "pt-PT": "pt" };

let settings = { ...DEFAULTS };
let agentLangs = LANG_FALLBACK;
let simulLangs = LANG_FALLBACK;
let running = false;
// The bubble currently being appended to, per direction and side, so streamed
// increments extend a line instead of starting a new one.
const openLines = new Map();

init();

async function init() {
  settings = await loadSettings();
  await populateLanguages();
  bind();
  render();
  const state = await send({ type: "getState" });
  running = !!state?.running;
  render();
}

/**
 * Language and voice lists come from the relay, so it stays the single source
 * of truth the way it is for the web app.
 *
 * A failure here is not fatal — English/Japanese is enough to reach the Options
 * page — but the two reasons it fails need different messages. Before the
 * backend origin has been granted, Chrome blocks the fetch and reports it as an
 * ordinary network error, which reads as "the server is down" when in fact
 * nothing was ever sent. So the permission is checked first and the missing
 * grant is named for what it is.
 */
async function populateLanguages() {
  let data = null;
  const origins = [originPattern(settings.backendUrl)].filter(Boolean);
  const granted = origins.length && (await chrome.permissions.contains({ origins }));
  if (!granted) {
    showError(
      `Access to ${settings.backendUrl} has not been granted yet. Press Start to ` +
        `grant it, or use Grant access in Options.`
    );
  } else {
    try {
      const resp = await fetch(new URL("/api/languages", settings.backendUrl));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    } catch (err) {
      showError(
        `Could not reach ${settings.backendUrl} (${err.message}). Check the backend ` +
          `in Options.`
      );
    }
  }
  agentLangs = data?.languages || LANG_FALLBACK;
  simulLangs = data?.simulLanguages || LANG_FALLBACK;
  // Only the tab target crosses model boundaries. The tab source is read solely
  // in agent mode, and the microphone direction is always agent mode.
  fillTabTarget();
  fill(el("tabSource"), agentLangs, settings.tabSource);
  fill(el("micSource"), agentLangs, settings.micSource);
  fill(el("micTarget"), agentLangs, settings.micTarget);
}

/**
 * The tab target's code set follows the auto-detect toggle.
 *
 * With auto-detect on the relay talks to the simultaneous-translation model,
 * whose BCP-47 codes differ for a handful of languages. Switching modes with
 * Chinese selected must land on Chinese, not silently reset to the top of the
 * list, so the code is mapped across before the dropdown is refilled.
 */
async function fillTabTarget() {
  const langs = settings.tabSimul ? simulLangs : agentLangs;
  const table = settings.tabSimul ? AGENT_TO_SIMUL : SIMUL_TO_AGENT;
  let code = settings.tabTarget;
  if (!(code in langs) && code in table) code = table[code];
  fill(el("tabTarget"), langs, code);
  if (el("tabTarget").value !== settings.tabTarget) {
    settings.tabTarget = el("tabTarget").value;
    await saveSettings({ tabTarget: settings.tabTarget });
  }
}

function fill(select, languages, selected) {
  select.innerHTML = "";
  const codes = Object.keys(languages).sort((a, b) =>
    languages[a].localeCompare(languages[b])
  );
  for (const code of codes) {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = languages[code];
    if (code === selected) opt.selected = true;
    select.appendChild(opt);
  }
  if (!codes.includes(selected) && codes.length) select.value = codes[0];
}

function bind() {
  for (const [id, key] of [
    ["tabEnabled", "tabEnabled"],
    ["tabSimul", "tabSimul"],
    ["micEnabled", "micEnabled"],
    ["captions", "captions"],
  ]) {
    el(id).addEventListener("change", () => update({ [key]: el(id).checked }));
  }
  for (const id of ["tabTarget", "tabSource", "micSource", "micTarget"]) {
    el(id).addEventListener("change", () => update({ [id]: el(id).value }));
  }
  el("duckLevel").addEventListener("input", () => {
    // Applied live by the offscreen document via storage.onChanged, so the
    // slider can be dragged while listening.
    update({ duckLevel: Number(el("duckLevel").value) / 100 });
  });
  el("toggle").addEventListener("click", onToggle);
  el("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
}

async function update(patch) {
  Object.assign(settings, patch);
  await saveSettings(patch);
  if ("tabSimul" in patch) await fillTabTarget();
  render();
  if (running && !("duckLevel" in patch)) {
    // Languages, direction and mode are all baked into the relay's session
    // config, so a change to any of them only takes effect on reconnect.
    await restart();
  }
}

function render() {
  el("tabEnabled").checked = settings.tabEnabled;
  el("tabSimul").checked = settings.tabSimul;
  el("micEnabled").checked = settings.micEnabled;
  el("captions").checked = settings.captions;
  el("tabTarget").value = settings.tabTarget;
  el("tabSource").value = settings.tabSource;
  el("micSource").value = settings.micSource;
  el("micTarget").value = settings.micTarget;
  el("duckLevel").value = Math.round(settings.duckLevel * 100);
  el("duckLevelOut").textContent = `${Math.round(settings.duckLevel * 100)}%`;

  el("tabSourceRow").hidden = settings.tabSimul;
  el("tabEnabled").closest(".direction").classList.toggle("off", !settings.tabEnabled);
  el("micEnabled").closest(".direction").classList.toggle("off", !settings.micEnabled);
  el("costNote").hidden = !(settings.tabEnabled && settings.micEnabled);

  el("toggle").textContent = running ? "Stop" : "Start";
  el("toggle").classList.toggle("running", running);
  el("toggle").disabled = !settings.tabEnabled && !settings.micEnabled;
  if (!running) setStatus("disconnected", "Idle");
}

async function onToggle() {
  el("toggle").disabled = true;
  clearError();
  try {
    if (running) {
      await send({ type: "stop" }, true);
      running = false;
    } else {
      await ensureBackendPermission();
      await send({ type: "start" }, true);
      running = true;
      el("transcript").innerHTML = "";
      openLines.clear();
    }
  } catch (err) {
    showError(err.message);
    running = false;
  }
  render();
  el("toggle").disabled = false;
}

async function restart() {
  await send({ type: "stop" }, true).catch(() => {});
  await send({ type: "start" }, true);
}

/**
 * The backend origin is a runtime permission, not an install-time one.
 *
 * The URL is configurable, so it cannot be baked into the manifest; asking for
 * it at Start rather than at install keeps the install prompt down to the
 * capture permissions. `permissions.request` needs a user gesture, which the
 * Start click is.
 */
async function ensureBackendPermission() {
  const origins = [originPattern(settings.backendUrl)].filter(Boolean);
  if (!origins.length) throw new Error("The backend URL in Options is not valid.");
  if (await chrome.permissions.contains({ origins })) return;
  const granted = await chrome.permissions.request({ origins });
  if (!granted) throw new Error(`Access to ${settings.backendUrl} was declined.`);
}

async function send(message, throwOnError = false) {
  const reply = await chrome.runtime.sendMessage({ target: "sw", ...message });
  if (throwOnError && reply && !reply.ok) throw new Error(reply.error);
  return reply;
}

// The grant can arrive from the Options page, from the Start button, or from
// chrome://extensions. Whichever it was, the language lists are now fetchable
// and the panel should stop showing an error the user has already dealt with.
chrome.permissions.onAdded.addListener(async () => {
  clearError();
  await populateLanguages();
  render();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "ui") return;
  if (msg.type === "state") {
    running = msg.running;
    render();
  } else if (msg.type === "status") {
    onStatus(msg);
  } else if (msg.type === "transcript") {
    onTranscript(msg);
  } else if (msg.type === "turnComplete") {
    for (const key of [...openLines.keys()]) {
      if (key.startsWith(msg.direction)) openLines.delete(key);
    }
  }
});

function onStatus({ status, detail }) {
  if (status === "connected") setStatus("", "Connected");
  else if (status === "connecting") setStatus("connecting", "Connecting…");
  else if (status === "error") setStatus("disconnected", detail || "Error");
  else if (status === "disconnected") setStatus("disconnected", "Reconnecting…");
}

function setStatus(cls, text) {
  el("statusDot").className = `dot ${cls}`;
  el("statusText").textContent = text;
}

function onTranscript({ direction, side, text, finished }) {
  const key = `${direction}:${side}`;
  let line = openLines.get(key);
  if (!line) {
    line = document.createElement("div");
    line.className = `line ${side}`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = side === "input" ? `heard (${direction})` : `translation (${direction})`;
    line.appendChild(tag);
    line.appendChild(document.createElement("span"));
    el("transcript").appendChild(line);
    openLines.set(key, line);
  }
  line.lastChild.textContent = text;
  if (finished) openLines.delete(key);
  el("transcript").scrollTop = el("transcript").scrollHeight;
}

function showError(message) {
  el("error").textContent = message;
  el("error").hidden = false;
}

function clearError() {
  el("error").hidden = true;
}
