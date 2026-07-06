/**
 * app.js: JS code for the Live Translator app.
 */

/**
 * WebSocket handling
 */

const userId = "demo-user";
let sessionId = "demo-session-" + Math.random().toString(36).substring(7);
let websocket = null;
const overlayChannel = new BroadcastChannel("live-translator");
let is_audio = false;
let pttMode = false;
let audioInitialized = false;

const SIMUL_KEY = "live-translator.simul";
const CONVO_KEY = "live-translator.convo";
let simulMode = localStorage.getItem(SIMUL_KEY) === "true";
// Conversation = bidirectional interpreter between the two chosen languages.
// Mutually exclusive with Simul; if both were persisted, Simul wins.
let convoMode = localStorage.getItem(CONVO_KEY) === "true";
if (simulMode && convoMode) {
  convoMode = false;
  localStorage.setItem(CONVO_KEY, "false");
}

const sourceLangSelect = document.getElementById("sourceLang");
const targetLangSelect = document.getElementById("targetLang");

// Hide subtitle when it would overlap controls or when header wraps
{
  const subtitle = document.querySelector(".subtitle");
  const controls = document.querySelector(".header-controls");
  const titleEl = document.querySelector("header h1");
  if (subtitle && controls && titleEl) {
    const check = () => {
      subtitle.hidden = false;
      const sr = subtitle.getBoundingClientRect();
      const cr = controls.getBoundingClientRect();
      const tr = titleEl.getBoundingClientRect();
      const overlaps = sr.top < cr.bottom && sr.bottom > cr.top && sr.right > cr.left;
      const headerWrapped = cr.top > tr.bottom - 4;
      const subtitleWraps = sr.bottom > tr.bottom + 4;
      subtitle.hidden = overlaps || headerWrapped || subtitleWraps;
    };
    requestAnimationFrame(check);
    window.addEventListener("resize", check);
  }
}

// Custom dropdown logic
function populateDropdown(hiddenInput, trigger, dropdown, selectedCode, languages, popular, allCodes) {
  dropdown.innerHTML = "";
  let foundSelected = false;

  function addOption(code) {
    const div = document.createElement("div");
    div.className = "custom-select-option";
    if (code === selectedCode) { div.classList.add("selected"); foundSelected = true; }
    div.textContent = languages[code];
    div.dataset.value = code;
    div.addEventListener("click", () => {
      hiddenInput.value = code;
      trigger.textContent = languages[code];
      dropdown.querySelectorAll(".custom-select-option").forEach(o => o.classList.remove("selected"));
      div.classList.add("selected");
      dropdown.classList.remove("open");
      reconnectWithNewLanguage();
    });
    dropdown.appendChild(div);
  }

  for (const code of popular) addOption(code);
  const divider = document.createElement("div");
  divider.className = "custom-select-divider";
  dropdown.appendChild(divider);
  for (const code of allCodes) addOption(code);

  if (foundSelected) {
    hiddenInput.value = selectedCode;
    trigger.textContent = languages[selectedCode];
  } else if (popular.length > 0) {
    const fallback = popular[0];
    hiddenInput.value = fallback;
    trigger.textContent = languages[fallback];
    const first = dropdown.querySelector('.custom-select-option');
    if (first) first.classList.add("selected");
  }
}

function setupCustomSelect(hiddenInput, trigger, dropdown, defaultCode, languages, popular, allCodes) {
  populateDropdown(hiddenInput, trigger, dropdown, defaultCode, languages, popular, allCodes);

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    // Close other dropdowns
    document.querySelectorAll(".custom-select-dropdown.open").forEach(d => {
      if (d !== dropdown) d.classList.remove("open");
    });
    dropdown.classList.toggle("open");
    // Scroll to selected item
    const selected = dropdown.querySelector(".selected");
    if (selected) selected.scrollIntoView({ block: "center" });
  });
}

// Swap languages
document.getElementById("swapLangs").addEventListener("click", () => {
  const srcVal = sourceLangSelect.value;
  const tgtVal = targetLangSelect.value;
  const srcTrigger = document.getElementById("sourceLangTrigger");
  const tgtTrigger = document.getElementById("targetLangTrigger");
  const srcText = srcTrigger.textContent;
  const tgtText = tgtTrigger.textContent;
  sourceLangSelect.value = tgtVal;
  targetLangSelect.value = srcVal;
  srcTrigger.textContent = tgtText;
  tgtTrigger.textContent = srcText;
  // Update selected states in dropdowns
  document.getElementById("sourceLangDropdown").querySelectorAll(".custom-select-option").forEach(o => {
    o.classList.toggle("selected", o.dataset.value === tgtVal);
  });
  document.getElementById("targetLangDropdown").querySelectorAll(".custom-select-option").forEach(o => {
    o.classList.toggle("selected", o.dataset.value === srcVal);
  });
  reconnectWithNewLanguage();
});

// Close dropdowns on outside click
document.addEventListener("click", () => {
  document.querySelectorAll(".custom-select-dropdown.open").forEach(d => d.classList.remove("open"));
});

// Populate language selectors from API
let agentLangs = {}, agentPopular = [], agentAllCodes = [];
let simulLangs = {}, simulPopularList = [], simulAllCodes = [];

const AGENT_TO_SIMUL = { "zh": "zh-Hans", "iw": "he", "pt": "pt-BR" };
const SIMUL_TO_AGENT = { "zh-Hans": "zh", "zh-Hant": "zh", "he": "iw", "pt-BR": "pt", "pt-PT": "pt" };

function rebuildTargetDropdown() {
  const langs = simulMode ? simulLangs : agentLangs;
  const popular = simulMode ? simulPopularList : agentPopular;
  const codes = simulMode ? simulAllCodes : agentAllCodes;
  const mapTable = simulMode ? AGENT_TO_SIMUL : SIMUL_TO_AGENT;
  let current = targetLangSelect.value;
  if (!(current in langs) && current in mapTable) current = mapTable[current];
  populateDropdown(
    targetLangSelect, document.getElementById("targetLangTrigger"),
    document.getElementById("targetLangDropdown"), current, langs, popular, codes
  );
}

async function loadLanguages() {
  const resp = await fetch("/api/languages");
  const data = await resp.json();
  window._modelName = data.model;
  window._vrModelName = data.vrModel;
  window._simulModelName = data.simulModel;

  agentLangs = data.languages;
  agentPopular = data.popular;
  agentAllCodes = Object.keys(agentLangs).sort((a, b) => agentLangs[a].localeCompare(agentLangs[b]));

  simulLangs = data.simulLanguages;
  simulPopularList = data.simulPopular;
  simulAllCodes = Object.keys(simulLangs).sort((a, b) => simulLangs[a].localeCompare(simulLangs[b]));

  setupCustomSelect(
    sourceLangSelect, document.getElementById("sourceLangTrigger"),
    document.getElementById("sourceLangDropdown"), "en", agentLangs, agentPopular, agentAllCodes
  );
  setupCustomSelect(
    targetLangSelect, document.getElementById("targetLangTrigger"),
    document.getElementById("targetLangDropdown"), "ja", agentLangs, agentPopular, agentAllCodes
  );

  if (simulMode) rebuildTargetDropdown();
}
loadLanguages();

function getWebSocketUrl() {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const source = sourceLangSelect.value;
  const target = targetLangSelect.value;
  let url = wsProtocol + "//" + window.location.host + "/ws/" + userId + "/" + sessionId + "?source=" + source + "&target=" + target;
  if (simulMode) url += "&simul=true";
  if (convoMode) url += "&convo=true";
  return url;
}

// Get DOM elements
const messagesDiv = document.getElementById("messages");
const statusIndicator = document.getElementById("statusIndicator");
const statusText = document.getElementById("statusText");
let currentMessageId = null;
let currentBubbleElement = null;
let currentInputTranscriptionId = null;
let currentInputTranscriptionElement = null;
let currentInputRawText = "";
let currentOutputTranscriptionId = null;
let currentOutputTranscriptionElement = null;
let currentOutputRawText = "";
let inputTranscriptionFinished = false;
let hasOutputTranscriptionInTurn = false;
let simulIdleTimer = null;
const SIMUL_IDLE_MS = 2000;

function finalizeTurn() {
  if (currentBubbleElement) {
    const ti = currentBubbleElement.querySelector(".typing-indicator");
    if (ti) ti.remove();
  }
  if (currentOutputTranscriptionElement) {
    const ti = currentOutputTranscriptionElement.querySelector(".typing-indicator");
    if (ti) ti.remove();
  }
  if (currentInputTranscriptionElement) {
    const ti = currentInputTranscriptionElement.querySelector(".typing-indicator");
    if (ti) ti.remove();
  }
  currentMessageId = null;
  currentBubbleElement = null;
  currentInputTranscriptionId = null;
  currentInputTranscriptionElement = null;
  currentInputRawText = "";
  currentOutputTranscriptionId = null;
  currentOutputTranscriptionElement = null;
  currentOutputRawText = "";
  inputTranscriptionFinished = false;
  hasOutputTranscriptionInTurn = false;
}

function resetSimulIdleTimer() {
  if (!simulMode) return;
  if (simulIdleTimer) clearTimeout(simulIdleTimer);
  simulIdleTimer = setTimeout(() => {
    simulIdleTimer = null;
    finalizeTurn();
  }, SIMUL_IDLE_MS);
}

// Helper function to clean spaces between CJK characters
function cleanCJKSpaces(text) {
  const cjkPattern = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\uff00-\uffef]/;
  return text.replace(/(\S)\s+(?=\S)/g, (match, char1) => {
    const nextCharMatch = text.match(new RegExp(char1 + '\\s+(.)', 'g'));
    if (nextCharMatch && nextCharMatch.length > 0) {
      const char2 = nextCharMatch[0].slice(-1);
      if (cjkPattern.test(char1) && cjkPattern.test(char2)) {
        return char1;
      }
    }
    return match;
  });
}

function updateConnectionStatus(status) {
  if (status === "connected") {
    statusIndicator.classList.remove("disconnected");
    statusIndicator.classList.remove("connecting");
    statusText.textContent = "Connected";
  } else if (status === "connecting") {
    statusIndicator.classList.remove("disconnected");
    statusIndicator.classList.add("connecting");
    statusText.textContent = "Connecting...";
  } else {
    statusIndicator.classList.add("disconnected");
    statusIndicator.classList.remove("connecting");
    statusText.textContent = "Disconnected";
  }
}

function createMessageBubble(text, isUser, isPartial = false) {
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${isUser ? "user" : "agent"}`;

  const bubbleDiv = document.createElement("div");
  bubbleDiv.className = "bubble";

  const textP = document.createElement("p");
  textP.className = "bubble-text";
  textP.textContent = text;

  if (isPartial && !isUser) {
    const typingSpan = document.createElement("span");
    typingSpan.className = "typing-indicator";
    textP.appendChild(typingSpan);
  }

  bubbleDiv.appendChild(textP);
  messageDiv.appendChild(bubbleDiv);
  return messageDiv;
}

function updateMessageBubble(element, text, isPartial = false) {
  const textElement = element.querySelector(".bubble-text");
  const existingIndicator = textElement.querySelector(".typing-indicator");
  if (existingIndicator) existingIndicator.remove();

  textElement.textContent = text;

  if (isPartial) {
    const typingSpan = document.createElement("span");
    typingSpan.className = "typing-indicator";
    textElement.appendChild(typingSpan);
  }
}

function addSystemMessage(text) {
  const messageDiv = document.createElement("div");
  messageDiv.className = "system-message";
  messageDiv.textContent = text;
  messagesDiv.appendChild(messageDiv);
  scrollToBottom();
  return messageDiv;
}

function scrollToBottom() {
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

let connectingMsg = null;

// WebSocket handlers
function connectWebsocket() {
  const ws_url = getWebSocketUrl();
  websocket = new WebSocket(ws_url);
  if (connectingMsg) connectingMsg.remove();
  connectingMsg = addSystemMessage("Connecting...");

  websocket.onopen = function () {
    updateConnectionStatus("connected");
    overlayChannel.postMessage({ type: "connected" });
    if (connectingMsg) {
      connectingMsg.remove();
      connectingMsg = null;
    }
    startAudioButton.disabled = false;
    pttToggle.disabled = false;
    // First message must be the setup payload (carries the per-browser glossary).
    const setup = { glossary: getGlossary() };
    const vrData = getVrData();
    if (vrData.voiceSample && vrData.consentAudio) {
      setup.voiceReplication = vrData;
    }
    websocket.send(JSON.stringify(setup));
  };

  websocket.onmessage = function (event) {
    const serverMsg = JSON.parse(event.data);

    // Handle turn complete
    if (serverMsg.turnComplete === true) {
      if (simulIdleTimer) { clearTimeout(simulIdleTimer); simulIdleTimer = null; }
      finalizeTurn();
      overlayChannel.postMessage({ type: "turnComplete" });
      return;
    }

    // Handle input transcription (user's spoken words)
    if (serverMsg.inputTranscription && serverMsg.inputTranscription.text) {
      const transcriptionText = serverMsg.inputTranscription.text;
      const isFinished = serverMsg.inputTranscription.finished;

      if (transcriptionText && !inputTranscriptionFinished) {
        if (currentInputTranscriptionId == null) {
          currentInputTranscriptionId = Math.random().toString(36).substring(7);
          currentInputRawText = transcriptionText;
          currentInputTranscriptionElement = createMessageBubble(cleanCJKSpaces(currentInputRawText), true, !isFinished);
          currentInputTranscriptionElement.id = currentInputTranscriptionId;
          currentInputTranscriptionElement.classList.add("transcription");
          messagesDiv.appendChild(currentInputTranscriptionElement);
        } else {
          if (isFinished) {
            currentInputRawText = transcriptionText;
          } else {
            currentInputRawText += transcriptionText;
          }
          updateMessageBubble(currentInputTranscriptionElement, cleanCJKSpaces(currentInputRawText), !isFinished);
        }

        if (isFinished) {
          currentInputTranscriptionId = null;
          currentInputTranscriptionElement = null;
          currentInputRawText = "";
          inputTranscriptionFinished = true;
        }
        scrollToBottom();
        resetSimulIdleTimer();
      }
    }

    // Handle output transcription (translated speech)
    if (serverMsg.outputTranscription && serverMsg.outputTranscription.text) {
      const transcriptionText = serverMsg.outputTranscription.text;
      const isFinished = serverMsg.outputTranscription.finished;
      hasOutputTranscriptionInTurn = true;

      if (transcriptionText) {
        if (currentOutputTranscriptionId == null) {
          currentOutputTranscriptionId = Math.random().toString(36).substring(7);
          currentOutputRawText = transcriptionText;
          currentOutputTranscriptionElement = createMessageBubble(applyDisplayMap(currentOutputRawText), false, !isFinished);
          currentOutputTranscriptionElement.id = currentOutputTranscriptionId;
          currentOutputTranscriptionElement.classList.add("transcription");
          messagesDiv.appendChild(currentOutputTranscriptionElement);
        } else {
          if (isFinished) {
            currentOutputRawText = transcriptionText;
            updateMessageBubble(currentOutputTranscriptionElement, applyDisplayMap(currentOutputRawText), false);
          } else {
            currentOutputRawText += transcriptionText;
            updateMessageBubble(currentOutputTranscriptionElement, applyDisplayMap(currentOutputRawText), true);
          }
        }

        overlayChannel.postMessage({
          type: "outputTranscription",
          text: applyDisplayMap(currentOutputRawText),
          finished: isFinished,
        });
        if (isFinished) {
          currentOutputTranscriptionId = null;
          currentOutputTranscriptionElement = null;
          currentOutputRawText = "";
        }
        scrollToBottom();
        resetSimulIdleTimer();
      }
    }

    // Handle content events (text or audio)
    if (serverMsg.content && serverMsg.content.parts) {
      const parts = serverMsg.content.parts;

      for (const part of parts) {
        if (part.inlineData) {
          const mimeType = part.inlineData.mimeType;
          const data = part.inlineData.data;
          if (mimeType && mimeType.startsWith("audio/pcm") && audioPlayerNode) {
            audioPlayerNode.port.postMessage(base64ToArray(data));
          }
        }

        if (part.text) {
          if (part.thought) continue;
          if (!serverMsg.partial && hasOutputTranscriptionInTurn) continue;

          if (currentMessageId == null) {
            currentMessageId = Math.random().toString(36).substring(7);
            currentBubbleElement = createMessageBubble(part.text, false, true);
            currentBubbleElement.id = currentMessageId;
            messagesDiv.appendChild(currentBubbleElement);
          } else {
            const existingText = currentBubbleElement.querySelector(".bubble-text").textContent;
            const cleanText = existingText.replace(/\.\.\.$/, '');
            updateMessageBubble(currentBubbleElement, cleanText + part.text, true);
          }
          scrollToBottom();
        }
      }
    }
  };

  websocket.onclose = function () {
    if (simulIdleTimer) { clearTimeout(simulIdleTimer); simulIdleTimer = null; }
    updateConnectionStatus("disconnected");
    overlayChannel.postMessage({ type: "disconnected" });
    startAudioButton.disabled = true;
    pttToggle.disabled = true;
    if (connectingMsg) connectingMsg.remove();
    connectingMsg = addSystemMessage("Connecting...");
    setTimeout(() => { connectWebsocket(); }, 5000);
  };

  websocket.onerror = function (e) {
    updateConnectionStatus("disconnected");
  };
}
connectWebsocket();

function reconnectWithNewLanguage() {
  sessionId = "demo-session-" + Math.random().toString(36).substring(7);
  updateConnectionStatus("connecting");
  startAudioButton.disabled = true;
  pttToggle.disabled = true;
  if (websocket) {
    websocket.onclose = null;
    websocket.close();
  }
  messagesDiv.innerHTML = '';
  const srcName = document.getElementById("sourceLangTrigger").textContent;
  const tgtName = document.getElementById("targetLangTrigger").textContent;
  const sep = convoMode ? " ⇄ " : " → ";
  const modeLabel = simulMode ? " (Simultaneous)" : convoMode ? " (Conversation)" : "";
  addSystemMessage(`${srcName}${sep}${tgtName}${modeLabel}`);
  connectWebsocket();
}

function base64ToArray(base64) {
  let standardBase64 = base64.replace(/-/g, '+').replace(/_/g, '/');
  while (standardBase64.length % 4) standardBase64 += '=';
  const binaryString = window.atob(standardBase64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Audio handling
 */

let audioPlayerNode;
let audioPlayerContext;
let audioRecorderNode;
let audioRecorderContext;
let micStream;

import { startAudioPlayerWorklet } from "./audio-player.js";
import { startAudioRecorderWorklet } from "./audio-recorder.js";

function startAudio() {
  const inputId = getSavedInputDevice();
  const outputId = getSavedOutputDevice();
  startAudioPlayerWorklet(outputId).then(([node, ctx]) => {
    audioPlayerNode = node;
    audioPlayerContext = ctx;
  });
  const loadingOverlay = document.getElementById("loadingOverlay");
  loadingOverlay.classList.remove("hidden");
  startAudioRecorderWorklet(audioRecorderHandler, inputId).then(([node, ctx, stream]) => {
    audioRecorderNode = node;
    audioRecorderContext = ctx;
    micStream = stream;
    setTimeout(() => {
      loadingOverlay.classList.add("hidden");
      const { src, tgt } = getLanguageNames();
      addSystemMessage(`Ready for ${src} to ${tgt} translation`);
      if (pttMode) {
        startAudioButton.disabled = false;
        is_audio = false;
      }
    }, 3000);
  });
}

// iOS drops audio contexts to "suspended"/"interrupted" on interruptions (and
// sometimes right after creation). Resume both on any user gesture / when the
// tab becomes visible again, so mic capture and playback keep working.
function resumeAudioContexts() {
  for (const ctx of [audioRecorderContext, audioPlayerContext]) {
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  }
}
["touchend", "mousedown", "keydown"].forEach((ev) =>
  document.addEventListener(ev, resumeAudioContexts, { passive: true })
);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) resumeAudioContexts();
});

const startAudioButton = document.getElementById("startAudioButton");
const pttToggle = document.getElementById("pttToggle");
const simulToggle = document.getElementById("simulToggle");
const convoToggle = document.getElementById("convoToggle");

simulToggle.checked = simulMode;
convoToggle.checked = convoMode;

function applySimulUi() {
  const glossaryBtn = document.getElementById("openGlossary");
  const langSelector = document.querySelector(".language-selector");
  const autoDetectLabel = document.getElementById("autoDetectLabel");
  const sourceLangWrapper = document.getElementById("sourceLangWrapper");
  const swapBtn = document.getElementById("swapLangs");
  const glossarySimulNote = document.getElementById("glossarySimulNote");
  if (simulMode) {
    sourceLangWrapper.style.display = "none";
    swapBtn.style.display = "none";
    autoDetectLabel.style.display = "";
    if (glossarySimulNote) glossarySimulNote.style.display = "";
  } else {
    sourceLangWrapper.style.display = "";
    swapBtn.style.display = "";
    autoDetectLabel.style.display = "none";
    if (glossarySimulNote) glossarySimulNote.style.display = "none";
  }
}
applySimulUi();

simulToggle.addEventListener("change", () => {
  simulMode = simulToggle.checked;
  localStorage.setItem(SIMUL_KEY, simulMode ? "true" : "false");
  if (simulMode && convoMode) {
    // Simul and Conversation are mutually exclusive.
    convoMode = false;
    convoToggle.checked = false;
    localStorage.setItem(CONVO_KEY, "false");
  }
  rebuildTargetDropdown();
  applySimulUi();
  reconnectWithNewLanguage();
});

convoToggle.addEventListener("change", () => {
  convoMode = convoToggle.checked;
  localStorage.setItem(CONVO_KEY, convoMode ? "true" : "false");
  if (convoMode && simulMode) {
    // Turning on Conversation cancels Simul; restore the two-way language UI.
    simulMode = false;
    simulToggle.checked = false;
    localStorage.setItem(SIMUL_KEY, "false");
    rebuildTargetDropdown();
    applySimulUi();
  }
  reconnectWithNewLanguage();
});

function initAudioIfNeeded() {
  if (audioInitialized) return;
  audioInitialized = true;
  startAudio();
}

function getLanguageNames() {
  const src = document.getElementById("sourceLangTrigger").textContent;
  const tgt = document.getElementById("targetLangTrigger").textContent;
  return { src, tgt };
}

// Always-on mode: click Start
startAudioButton.addEventListener("click", () => {
  if (pttMode) return;
  startAudioButton.disabled = true;
  initAudioIfNeeded();
  is_audio = true;
});

// PTT toggle
pttToggle.addEventListener("change", () => {
  pttMode = pttToggle.checked;
  if (pttMode) {
    startAudioButton.classList.add("ptt-mode");
    if (!audioInitialized) {
      startAudioButton.disabled = true;
      startAudioButton.textContent = "Hold to Talk";
      initAudioIfNeeded();
      is_audio = true;
    } else {
      startAudioButton.disabled = false;
      startAudioButton.textContent = "Hold to Talk";
      is_audio = false;
    }
  } else {
    startAudioButton.classList.remove("ptt-mode");
    startAudioButton.classList.remove("ptt-active");
    startAudioButton.textContent = "Start";
    is_audio = false;
    audioInitialized = false;
    reconnectWithNewLanguage();
  }
});

// PTT hold handlers
function pttDown(e) {
  if (!pttMode || startAudioButton.disabled) return;
  e.preventDefault();
  if (pttTailTimeout) { clearTimeout(pttTailTimeout); pttTailTimeout = null; }
  is_audio = true;
  startAudioButton.classList.add("ptt-active");
  startAudioButton.textContent = "Talking...";
}

let pttTailTimeout = null;

function pttUp() {
  if (!pttMode) return;
  startAudioButton.classList.remove("ptt-active");
  startAudioButton.textContent = "Hold to Talk";
  if (pttTailTimeout) clearTimeout(pttTailTimeout);
  pttTailTimeout = setTimeout(() => {
    is_audio = false;
    pttTailTimeout = null;
  }, 1500);
}

startAudioButton.addEventListener("mousedown", pttDown);
startAudioButton.addEventListener("mouseup", pttUp);
startAudioButton.addEventListener("mouseleave", pttUp);
startAudioButton.addEventListener("touchstart", pttDown);
startAudioButton.addEventListener("touchend", pttUp);
startAudioButton.addEventListener("touchcancel", pttUp);

// Spacebar shortcut for PTT
document.addEventListener("keydown", (e) => {
  if (!pttMode || e.repeat) return;
  if (e.code === "Space" && !e.target.matches("input, textarea, select, button:not(#startAudioButton)")) {
    e.preventDefault();
    pttDown(e);
  }
});
document.addEventListener("keyup", (e) => {
  if (!pttMode) return;
  if (e.code === "Space" && !e.target.matches("input, textarea, select")) {
    e.preventDefault();
    pttUp();
  }
});

function audioRecorderHandler(pcmData) {
  if (websocket && websocket.readyState === WebSocket.OPEN && is_audio) {
    websocket.send(pcmData);
  }
}

/**
 * Glossary (client-side, per browser)
 *
 * The glossary lives in this browser only — stored in localStorage and sent
 * to the server as the first WebSocket message of each session. The server
 * never persists it, so different browsers can run different glossaries
 * concurrently.
 */
const GLOSSARY_KEY = "live-translator.glossary.v2";
const MAX_GLOSSARY_BYTES = 256 * 1024;
const MAX_GLOSSARY_ENTRIES = 1000;

const glossaryOverlay = document.getElementById("glossaryOverlay");
const glossaryList = document.getElementById("glossaryList");
const glossaryCount = document.getElementById("glossaryCount");
const glossaryStatus = document.getElementById("glossaryStatus");
const glossaryFile = document.getElementById("glossaryFile");

let glossaryPairs = loadGlossaryFromStorage();
let glossaryDisplayMap = buildDisplayMap(glossaryPairs);

function normalizeEntry(p) {
  if (!p || typeof p.source !== "string" || typeof p.target !== "string") return null;
  const source = p.source;
  const target = p.target;
  const transcription = typeof p.transcription === "string" && p.transcription.length
    ? p.transcription
    : target;
  return { source, target, transcription };
}

function loadGlossaryFromStorage() {
  try {
    const raw = localStorage.getItem(GLOSSARY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(normalizeEntry).filter(Boolean);
  } catch {
    return null;
  }
}

function saveGlossaryToStorage(pairs) {
  try {
    localStorage.setItem(GLOSSARY_KEY, JSON.stringify(pairs));
  } catch (err) {
    console.warn("Failed to persist glossary to localStorage:", err);
  }
}

function getGlossary() {
  return glossaryPairs || [];
}

function buildDisplayMap(pairs) {
  const map = [];
  for (const p of pairs || []) {
    if (p.transcription && p.transcription !== p.target) {
      map.push([p.target, p.transcription]);
    }
  }
  // Apply longer targets first so a longer match wins over a shorter prefix.
  map.sort((a, b) => b[0].length - a[0].length);
  return map;
}

function applyDisplayMap(text) {
  if (!text || !glossaryDisplayMap.length) return text;
  let out = text.normalize('NFKC');
  for (const [from, to] of glossaryDisplayMap) {
    const nFrom = from.normalize('NFKC');
    if (out.includes(nFrom)) out = out.split(nFrom).join(to);
  }
  return out;
}

function setGlossary(pairs) {
  glossaryPairs = pairs.map(normalizeEntry).filter(Boolean);
  glossaryDisplayMap = buildDisplayMap(glossaryPairs);
  saveGlossaryToStorage(glossaryPairs);
}

function parseGlossaryCsv(text) {
  const pairs = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Split into at most 3 fields so that the 2nd and 3rd may themselves
    // contain commas? The spec is simple CSV; we don't support quoted commas.
    const parts = line.split(",");
    if (parts.length < 2) {
      throw new Error(`Line ${i + 1} must be 'source,target' (3rd column optional).`);
    }
    const source = parts[0].trim();
    const target = parts[1].trim();
    const transcription = (parts.length >= 3 ? parts.slice(2).join(",").trim() : "") || target;
    if (!source || !target) {
      throw new Error(`Line ${i + 1} is missing source or target.`);
    }
    pairs.push({ source, target, transcription });
    if (pairs.length > MAX_GLOSSARY_ENTRIES) {
      throw new Error(`Too many entries (max ${MAX_GLOSSARY_ENTRIES}).`);
    }
  }
  return pairs;
}

function renderGlossary(pairs) {
  glossaryCount.textContent = pairs.length;
  if (!pairs.length) {
    glossaryList.innerHTML = '<div class="glossary-empty">No glossary entries.</div>';
    return;
  }
  const table = document.createElement("table");
  table.className = "glossary-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Source", "Pronunciation", "Transcript"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const { source, target, transcription } of pairs) {
    const tr = document.createElement("tr");
    for (const value of [source, target, transcription || target]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  glossaryList.innerHTML = "";
  glossaryList.appendChild(table);
}

function setGlossaryStatus(text, kind) {
  glossaryStatus.textContent = text || "";
  glossaryStatus.className = "glossary-status" + (kind ? " " + kind : "");
}

async function fetchDefaultGlossary() {
  const resp = await fetch("/api/glossary/defaults");
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const { pairs } = await resp.json();
  return pairs;
}

async function ensureGlossarySeeded() {
  if (glossaryPairs !== null) return;
  try {
    const defaults = await fetchDefaultGlossary();
    setGlossary(defaults);
  } catch (err) {
    console.warn("Failed to seed default glossary:", err);
    setGlossary([]);
  }
}

ensureGlossarySeeded();

document.getElementById("openGlossary").addEventListener("click", async () => {
  glossaryOverlay.classList.remove("hidden");
  setGlossaryStatus("");
  await ensureGlossarySeeded();
  renderGlossary(getGlossary());
});

document.getElementById("closeGlossary").addEventListener("click", () => {
  glossaryOverlay.classList.add("hidden");
});

glossaryOverlay.addEventListener("click", (e) => {
  if (e.target === glossaryOverlay) glossaryOverlay.classList.add("hidden");
});

document.getElementById("uploadGlossary").addEventListener("click", async () => {
  const file = glossaryFile.files[0];
  if (!file) {
    setGlossaryStatus("Pick a .csv file first.", "error");
    return;
  }
  if (!file.name.toLowerCase().endsWith(".csv")) {
    setGlossaryStatus("File must have a .csv extension.", "error");
    return;
  }
  if (file.size > MAX_GLOSSARY_BYTES) {
    setGlossaryStatus(`File exceeds ${MAX_GLOSSARY_BYTES} bytes.`, "error");
    return;
  }
  try {
    const text = await file.text();
    const pairs = parseGlossaryCsv(text);
    setGlossary(pairs);
    renderGlossary(pairs);
    setGlossaryStatus(
      `Replaced with ${pairs.length} entries. Applies on next session.`,
      "ok"
    );
    glossaryFile.value = "";
  } catch (err) {
    setGlossaryStatus("Load failed: " + err.message, "error");
  }
});

document.getElementById("resetGlossary").addEventListener("click", async () => {
  try {
    const defaults = await fetchDefaultGlossary();
    setGlossary(defaults);
    renderGlossary(defaults);
    setGlossaryStatus(
      `Reset to ${defaults.length} default entries. Applies on next session.`,
      "ok"
    );
    glossaryFile.value = "";
  } catch (err) {
    setGlossaryStatus("Reset failed: " + err.message, "error");
  }
});

/**
 * Audio device selection (per browser, stored in localStorage)
 */
const AUDIO_INPUT_KEY = "live-translator.audio.inputDeviceId";
const AUDIO_OUTPUT_KEY = "live-translator.audio.outputDeviceId";

function getSavedInputDevice() {
  return localStorage.getItem(AUDIO_INPUT_KEY) || "";
}
function setSavedInputDevice(id) {
  if (id) localStorage.setItem(AUDIO_INPUT_KEY, id);
  else localStorage.removeItem(AUDIO_INPUT_KEY);
}
function getSavedOutputDevice() {
  return localStorage.getItem(AUDIO_OUTPUT_KEY) || "";
}
function setSavedOutputDevice(id) {
  if (id) localStorage.setItem(AUDIO_OUTPUT_KEY, id);
  else localStorage.removeItem(AUDIO_OUTPUT_KEY);
}

const audioOverlay = document.getElementById("audioOverlay");
const audioInputSelect = document.getElementById("audioInputSelect");
const audioOutputSelect = document.getElementById("audioOutputSelect");
const audioHint = document.getElementById("audioHint");

async function populateAudioDevices() {
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some(d => d.label)) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    }
  } catch {
    audioHint.textContent = "Could not enumerate audio devices.";
    return;
  }

  const inputs = devices.filter(d => d.kind === "audioinput");
  const outputs = devices.filter(d => d.kind === "audiooutput");
  const hasLabels = inputs.some(d => d.label);

  audioHint.textContent = hasLabels
    ? ""
    : "Grant microphone permission to see device names.";

  const savedInput = getSavedInputDevice();
  const savedOutput = getSavedOutputDevice();

  audioInputSelect.innerHTML = "";
  const defaultIn = document.createElement("option");
  defaultIn.value = "";
  defaultIn.textContent = "System Default";
  audioInputSelect.appendChild(defaultIn);
  for (const d of inputs) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone (${d.deviceId.slice(0, 8)}...)`;
    if (d.deviceId === savedInput) opt.selected = true;
    audioInputSelect.appendChild(opt);
  }

  audioOutputSelect.innerHTML = "";
  const defaultOut = document.createElement("option");
  defaultOut.value = "";
  defaultOut.textContent = "System Default";
  audioOutputSelect.appendChild(defaultOut);
  for (const d of outputs) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Speaker (${d.deviceId.slice(0, 8)}...)`;
    if (d.deviceId === savedOutput) opt.selected = true;
    audioOutputSelect.appendChild(opt);
  }
}

audioInputSelect.addEventListener("change", () => {
  setSavedInputDevice(audioInputSelect.value);
});

audioOutputSelect.addEventListener("change", () => {
  setSavedOutputDevice(audioOutputSelect.value);
});

document.getElementById("applyAudio").addEventListener("click", async () => {
  if (audioRecorderContext) {
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    await audioRecorderContext.close();
    const [node, ctx, stream] = await startAudioRecorderWorklet(audioRecorderHandler, getSavedInputDevice());
    audioRecorderNode = node;
    audioRecorderContext = ctx;
    micStream = stream;
  }
  if (audioPlayerContext) {
    await audioPlayerContext.close();
    const [node, ctx] = await startAudioPlayerWorklet(getSavedOutputDevice());
    audioPlayerNode = node;
    audioPlayerContext = ctx;
  }
  audioOverlay.classList.add("hidden");
});

document.getElementById("closeAudio").addEventListener("click", () => {
  audioOverlay.classList.add("hidden");
});

audioOverlay.addEventListener("click", (e) => {
  if (e.target === audioOverlay) audioOverlay.classList.add("hidden");
});

/**
 * Voice Replication (opt-in, per browser)
 *
 * Records voice sample and consent audio at 24kHz mono 16-bit WAV,
 * stores as base64 in localStorage, and sends to the server in the
 * setup message so the Gemini Live API can clone the user's voice.
 */
const VR_KEY = "live-translator.vr.voiceRecording";

const vrSection = document.getElementById("vrSection");
const vrToggle = document.getElementById("vrToggle");
const vrStatus = document.getElementById("vrStatus");
const vrRecordBtn = document.getElementById("vrRecord");
const vrPlayBtn = document.getElementById("vrPlay");
const vrClearBtn = document.getElementById("vrClear");
const vrDurationSpan = document.getElementById("vrDuration");

let vrRecordingCtx = null;
let vrRecordingStream = null;
let vrRecordingChunks = [];
let vrIsRecording = false;
let vrRecordingTimer = null;
let vrRecordingStart = 0;
let vrPlaybackCtx = null;
let vrPlaybackSource = null;

vrToggle.addEventListener("click", () => {
  vrSection.classList.toggle("open");
});

function encodeWav24k(float32Samples) {
  const numSamples = float32Samples.length;
  const pcmBytes = numSamples * 2;
  const buffer = new ArrayBuffer(44 + pcmBytes);
  const view = new DataView(buffer);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcmBytes, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(offset, s * 0x7fff, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function getVrData() {
  const b64 = localStorage.getItem(VR_KEY) || null;
  return { voiceSample: b64, consentAudio: b64 };
}

function isVrEnabled() {
  return !!localStorage.getItem(VR_KEY);
}

function getVrDurationStr() {
  const b64 = localStorage.getItem(VR_KEY);
  if (!b64) return "";
  const rawBytes = b64.length * 3 / 4;
  const pcmBytes = rawBytes - 44;
  if (pcmBytes <= 0) return "";
  const secs = pcmBytes / (24000 * 2);
  return secs.toFixed(1) + "s";
}

function updateVrUi() {
  const hasRecording = !!localStorage.getItem(VR_KEY);
  const modelDisplay = document.getElementById("modelNameDisplay");

  if (simulMode) {
    vrRecordBtn.disabled = true;
    vrPlayBtn.disabled = true;
    vrClearBtn.disabled = true;
    vrSection.classList.add("disabled");
    vrStatus.textContent = "Not available in Simultaneous mode.";
    vrStatus.className = "vr-status";
    if (modelDisplay) modelDisplay.textContent = window._simulModelName || "";
  } else {
    vrRecordBtn.disabled = false;
    vrPlayBtn.disabled = !hasRecording || vrIsRecording;
    vrClearBtn.disabled = !hasRecording || vrIsRecording;
    vrSection.classList.remove("disabled");
    if (hasRecording) {
      vrStatus.textContent = "Voice replication ready.";
      vrStatus.className = "vr-status ok";
      if (modelDisplay) modelDisplay.textContent = window._vrModelName || "";
    } else {
      vrStatus.textContent = "";
      vrStatus.className = "vr-status";
      if (modelDisplay) modelDisplay.textContent = window._modelName || "";
    }
  }
  vrDurationSpan.textContent = getVrDurationStr();
}

async function startVrRecording() {
  if (vrIsRecording) return;
  vrIsRecording = true;
  vrRecordingChunks = [];

  try {
    vrRecordingCtx = new AudioContext({ sampleRate: 24000 });
    const constraints = { audio: { channelCount: 1 } };
    const inputId = getSavedInputDevice();
    if (inputId) constraints.audio.deviceId = { exact: inputId };
    vrRecordingStream = await navigator.mediaDevices.getUserMedia(constraints);

    const source = vrRecordingCtx.createMediaStreamSource(vrRecordingStream);
    const processor = vrRecordingCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      vrRecordingChunks.push(new Float32Array(data));
    };

    source.connect(processor);
    processor.connect(vrRecordingCtx.destination);

    vrRecordingStart = performance.now();
    vrRecordBtn.textContent = "Stop";
    vrRecordBtn.classList.add("recording");

    vrRecordingTimer = setInterval(() => {
      const elapsed = (performance.now() - vrRecordingStart) / 1000;
      vrDurationSpan.textContent = elapsed.toFixed(1) + "s";
    }, 100);

    updateVrUi();
  } catch (err) {
    vrIsRecording = false;
    vrStatus.textContent = "Microphone access denied.";
    vrStatus.className = "vr-status error";
    updateVrUi();
  }
}

function stopVrRecording() {
  if (!vrIsRecording) return;

  clearInterval(vrRecordingTimer);
  vrRecordingTimer = null;

  if (vrRecordingStream) {
    vrRecordingStream.getTracks().forEach(t => t.stop());
    vrRecordingStream = null;
  }
  if (vrRecordingCtx) {
    vrRecordingCtx.close();
    vrRecordingCtx = null;
  }

  let totalLen = 0;
  for (const chunk of vrRecordingChunks) totalLen += chunk.length;
  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of vrRecordingChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  vrRecordingChunks = [];
  vrIsRecording = false;

  const wav = encodeWav24k(merged);
  const b64 = arrayBufferToBase64(wav.buffer);

  try {
    localStorage.setItem(VR_KEY, b64);
  } catch (err) {
    vrStatus.textContent = "Failed to save recording (storage full?).";
    vrStatus.className = "vr-status error";
  }

  vrRecordBtn.textContent = "Record";
  vrRecordBtn.classList.remove("recording");
  updateVrUi();
}

async function playVrRecording() {
  stopVrPlayback();
  const b64 = localStorage.getItem(VR_KEY);
  if (!b64) return;

  try {
    vrPlaybackCtx = new AudioContext({ sampleRate: 24000 });
    const arrayBuf = base64ToArrayBuffer(b64);
    const audioBuf = await vrPlaybackCtx.decodeAudioData(arrayBuf);
    vrPlaybackSource = vrPlaybackCtx.createBufferSource();
    vrPlaybackSource.buffer = audioBuf;
    vrPlaybackSource.connect(vrPlaybackCtx.destination);
    vrPlaybackSource.onended = () => stopVrPlayback();
    vrPlaybackSource.start();
  } catch {
    stopVrPlayback();
  }
}

function stopVrPlayback() {
  if (vrPlaybackSource) {
    try { vrPlaybackSource.stop(); } catch {}
    vrPlaybackSource = null;
  }
  if (vrPlaybackCtx) {
    vrPlaybackCtx.close();
    vrPlaybackCtx = null;
  }
}

function clearVrRecording() {
  stopVrPlayback();
  localStorage.removeItem(VR_KEY);
  updateVrUi();
}

vrRecordBtn.addEventListener("click", () => {
  if (vrIsRecording) stopVrRecording();
  else startVrRecording();
});

vrPlayBtn.addEventListener("click", () => playVrRecording());
vrClearBtn.addEventListener("click", () => clearVrRecording());

document.getElementById("openOverlay").addEventListener("click", () => {
  window.open("/caption", "live-translator-caption");
});

document.getElementById("openAudio").addEventListener("click", async () => {
  audioOverlay.classList.remove("hidden");
  await populateAudioDevices();
  updateVrUi();
});
