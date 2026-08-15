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
// In always-on mode the Start button has nothing left to do once audio is
// running, so it becomes the microphone mute control. micRunning gates that
// second life: audioInitialized flips before the mic is actually up.
let micRunning = false;
let micMuted = false;
// Silences the translated speech without touching the microphone: the room
// still gets translated, this listener just stops hearing it out loud. Wanted
// whenever the audio is going somewhere else — a PA, another laptop, or the
// person next to you reading the captions instead.
let outputMuted = false;

const SIMUL_KEY = "live-translator.simul";
let simulMode = localStorage.getItem(SIMUL_KEY) === "true";
// Conversation = bidirectional interpreter between the two chosen languages.
// It is now the only alternative to Simul, so it has no toggle and no stored
// preference of its own: anything that is not Simul is a conversation.
let convoMode = !simulMode;

const sourceLangSelect = document.getElementById("sourceLang");
const targetLangSelect = document.getElementById("targetLang");

// The language pair is the first thing anyone sets and rarely the thing they
// want to change, so it is remembered per browser like the Simul toggle above.
const LANG_KEYS = {
  sourceLang: "live-translator.sourceLang",
  targetLang: "live-translator.targetLang",
};
const DEFAULT_LANGS = { sourceLang: "en", targetLang: "ja" };

function storedLang(hiddenInput) {
  return localStorage.getItem(LANG_KEYS[hiddenInput.id]) || DEFAULT_LANGS[hiddenInput.id];
}

function rememberLang(hiddenInput, code) {
  localStorage.setItem(LANG_KEYS[hiddenInput.id], code);
}

// Seed the inputs before anything reads them. The first WebSocket opens while
// the language list is still being fetched, so it takes whatever these hold —
// leave them on the markup's en/ja and the restored pair is only on screen,
// with the session itself running on the wrong languages until something else
// forces a reconnect. The stored target is already in the current mode's code
// set, so it needs no mapping here.
sourceLangSelect.value = storedLang(sourceLangSelect);
targetLangSelect.value = storedLang(targetLangSelect);

// Whether the two sides match is answerable without the language list, so the
// pair is separated here as well as after the fetch. Left to the later pass
// alone, every load of an affected browser would open a session on a pair it
// is about to abandon and immediately reconnect.
if (!simulMode && sourceLangSelect.value === targetLangSelect.value) {
  targetLangSelect.value = sourceLangSelect.value === DEFAULT_LANGS.targetLang
    ? DEFAULT_LANGS.sourceLang
    : DEFAULT_LANGS.targetLang;
}

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
      const previous = hiddenInput.value;
      hiddenInput.value = code;
      rememberLang(hiddenInput, code);
      trigger.textContent = languages[code];
      dropdown.querySelectorAll(".custom-select-option").forEach(o => o.classList.remove("selected"));
      div.classList.add("selected");
      dropdown.classList.remove("open");
      // Runs before the reconnect so the session opens on the corrected pair
      // rather than on one the UI is about to move away from.
      separateLanguages(hiddenInput, previous);
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

// Close dropdowns on outside click
document.addEventListener("click", () => {
  document.querySelectorAll(".custom-select-dropdown.open").forEach(d => d.classList.remove("open"));
});

// Populate language selectors from API
let agentLangs = {}, agentPopular = [], agentAllCodes = [];
let simulLangs = {}, simulPopularList = [], simulAllCodes = [];

const AGENT_TO_SIMUL = { "zh": "zh-Hans", "iw": "he", "pt": "pt-BR" };
const SIMUL_TO_AGENT = { "zh-Hans": "zh", "zh-Hant": "zh", "he": "iw", "pt-BR": "pt", "pt-PT": "pt" };

/**
 * Repopulate the target dropdown for whichever mode is now active.
 *
 * *preferred* is for restoring a stored choice: the two modes do not share a
 * code set, and a stored simul-only variant (`zh-Hant`, `pt-PT`) has no agent
 * equivalent to come back through, so it is handed in directly rather than
 * round-tripped and flattened to `zh` / `pt`.
 */
function rebuildTargetDropdown(preferred) {
  const langs = simulMode ? simulLangs : agentLangs;
  const popular = simulMode ? simulPopularList : agentPopular;
  const codes = simulMode ? simulAllCodes : agentAllCodes;
  const mapTable = simulMode ? AGENT_TO_SIMUL : SIMUL_TO_AGENT;
  let current = preferred ?? targetLangSelect.value;
  if (!(current in langs) && current in mapTable) current = mapTable[current];
  populateDropdown(
    targetLangSelect, document.getElementById("targetLangTrigger"),
    document.getElementById("targetLangDropdown"), current, langs, popular, codes
  );
  // Store the code for the mode actually on screen, so the next visit restores
  // the variant that was showing rather than the one it was mapped from.
  rememberLang(targetLangSelect, targetLangSelect.value);
}

/** Move one dropdown to *code*, repainting its list so the label agrees. */
function setLangDropdown(hiddenInput, code) {
  if (hiddenInput === targetLangSelect) {
    rebuildTargetDropdown(code); // picks the right code set for the mode, and stores it
    return;
  }
  populateDropdown(
    sourceLangSelect, document.getElementById("sourceLangTrigger"),
    document.getElementById("sourceLangDropdown"), code,
    agentLangs, agentPopular, agentAllCodes
  );
  rememberLang(sourceLangSelect, sourceLangSelect.value);
}

/**
 * Keep the two sides on different languages, moving the side that was not just
 * touched. Returns whether anything had to change.
 *
 * Conversation interprets between the pair, so the same language on both sides
 * leaves it nothing to do. Reaching that state takes nothing odd: translating
 * *into* English is an ordinary Simul setup, and switching back to conversation
 * drops that English opposite the English source. Persisting the pair made it
 * stick across reloads instead of resetting, which is how a browser ends up
 * coming back English ⇄ English every time.
 *
 * Simul is exempt — it is one-way, and its source dropdown is hidden precisely
 * because the value is ignored.
 */
function separateLanguages(changedInput, previousCode) {
  if (simulMode) return false;
  if (sourceLangSelect.value !== targetLangSelect.value) return false;
  const other = changedInput === sourceLangSelect ? targetLangSelect : sourceLangSelect;
  // On a pick, the untouched side takes the value the touched one just gave up:
  // that is a straight swap of a pair the user already had, so it needs no
  // guessing. Elsewhere there is no such value and the first popular language
  // that differs is as good a choice as any.
  const replacement = previousCode && previousCode !== changedInput.value
    ? previousCode
    : agentPopular.find((c) => c !== changedInput.value && c in agentLangs);
  if (!replacement) return false;
  setLangDropdown(other, replacement);
  return true;
}

// What the live session was actually opened with, as opposed to what the
// dropdowns show — the two can drift apart while the language list loads.
let connectedSource = null;
let connectedTarget = null;

async function loadLanguages() {
  const resp = await fetch("/api/languages");
  const data = await resp.json();
  window._modelName = data.model;
  window._simulModelName = data.simulModel;

  populateVoiceSelect(data.voices, data.defaultVoice);

  agentLangs = data.languages;
  agentPopular = data.popular;
  agentAllCodes = Object.keys(agentLangs).sort((a, b) => agentLangs[a].localeCompare(agentLangs[b]));

  simulLangs = data.simulLanguages;
  simulPopularList = data.simulPopular;
  simulAllCodes = Object.keys(simulLangs).sort((a, b) => simulLangs[a].localeCompare(simulLangs[b]));

  // Both dropdowns are built from the agent code set first, whatever the mode,
  // so a target stored while in Simul has to come back through the reverse map
  // to be found here at all — otherwise it reads as unknown and the stored
  // choice is quietly replaced by the first popular language.
  const savedTarget = storedLang(targetLangSelect);
  const agentTarget = savedTarget in agentLangs ? savedTarget : (SIMUL_TO_AGENT[savedTarget] ?? savedTarget);

  setupCustomSelect(
    sourceLangSelect, document.getElementById("sourceLangTrigger"),
    document.getElementById("sourceLangDropdown"), storedLang(sourceLangSelect),
    agentLangs, agentPopular, agentAllCodes
  );
  setupCustomSelect(
    targetLangSelect, document.getElementById("targetLangTrigger"),
    document.getElementById("targetLangDropdown"), agentTarget,
    agentLangs, agentPopular, agentAllCodes
  );

  if (simulMode) rebuildTargetDropdown(savedTarget);

  // A stored pair can be equal — most often both English, since the fallback
  // for an unknown code is the first popular language and that is English on
  // both sides. Move the target off it before the comparison below, which then
  // reopens the session on the pair actually being shown.
  separateLanguages(sourceLangSelect, null);

  // A stored code the server no longer offers has just been replaced by a
  // fallback, and Simul remaps the target on top of that. Either way the
  // session opened a moment ago is on a pair that is no longer on screen, so
  // reopen it rather than leave the two disagreeing.
  if (sourceLangSelect.value !== connectedSource || targetLangSelect.value !== connectedTarget) {
    reconnectWithNewLanguage();
  }
}
loadLanguages();

function getWebSocketUrl() {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const source = sourceLangSelect.value;
  const target = targetLangSelect.value;
  connectedSource = source;
  connectedTarget = target;
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
    // First message must be the setup payload (carries the per-browser
    // glossary and the chosen output voice).
    activeVoice = getVoice();
    websocket.send(JSON.stringify({ glossary: getGlossary(), voice: activeVoice }));
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
          // Muted output drops the chunk rather than just turning the gain
          // down: the model streams far faster than realtime, so a minute of
          // muted speech would otherwise sit in the worklet's ring buffer and
          // pour out on unmute. Unmuting resumes with whatever is being said
          // then, which is what a mute is expected to do.
          if (mimeType && mimeType.startsWith("audio/pcm") && audioPlayerNode && !outputMuted) {
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
  addSystemMessage(sessionDescription());
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
let audioPlayerGain;
let audioRecorderNode;
let audioRecorderContext;
let micStream;
// Devices the running pipeline actually settled on, so a device-list change can
// tell whether a better-ranked one has appeared. "" means the system default.
let activeInputDeviceId = "";
let activeOutputDeviceId = "";

import { startAudioPlayerWorklet } from "./audio-player.js";
import { startAudioRecorderWorklet } from "./audio-recorder.js";

// Hard ceiling on how long the "Starting audio" overlay may stay up. Mic
// startup can hang rather than reject (a suspended AudioContext in an occluded
// window, a wedged device), and a stuck overlay blocks the whole UI — so it
// always comes down, with an error the user can act on.
const AUDIO_START_WATCHDOG_MS = 15000;
const AUDIO_WARMUP_MS = 3000;

function startAudio() {
  const inputPrefs = getPriority(AUDIO_INPUT_KEY);
  const outputPrefs = getPriority(AUDIO_OUTPUT_KEY);
  const loadingOverlay = document.getElementById("loadingOverlay");
  loadingOverlay.classList.remove("hidden");

  let settled = false;

  function finishAudioStart(errMsg) {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    loadingOverlay.classList.add("hidden");
    if (errMsg) {
      // Leave the app usable and let Start be clicked again.
      audioInitialized = false;
      is_audio = false;
      micRunning = false;
      micMuted = false;
      updateAudioControls();
      startAudioButton.disabled = false;
      addSystemMessage(`Could not start audio: ${errMsg}`);
      return;
    }
    const { src, tgt } = getLanguageNames();
    addSystemMessage(
      simulMode
        ? `Ready to translate into ${tgt}`
        : `Ready to interpret between ${src} and ${tgt}`
    );
    // Either way there is now playback to silence, so the speaker button
    // appears — push-to-talk already owns the microphone, but not the output.
    if (pttMode) {
      is_audio = false;
    } else {
      // The mic is live, so the button turns into the microphone toggle.
      micRunning = true;
    }
    updateAudioControls();
    startAudioButton.disabled = false;
  }

  const watchdog = setTimeout(
    () => finishAudioStart("timed out starting the microphone. Click Start to retry."),
    AUDIO_START_WATCHDOG_MS
  );

  startAudioPlayerWorklet(outputPrefs).then(([node, ctx, sinkId, gain]) => {
    audioPlayerNode = node;
    audioPlayerContext = ctx;
    activeOutputDeviceId = sinkId;
    audioPlayerGain = gain;
    // A fresh gain node starts at 1, so a mute set before this resolved (or
    // carried over from the previous player) has to be re-applied.
    applyOutputGain();
  }).catch((err) => {
    // Playback is not fatal — transcripts still work without audio out.
    console.error("Audio player failed to start:", err);
  });

  startAudioRecorderWorklet(audioRecorderHandler, inputPrefs).then(([node, ctx, stream]) => {
    audioRecorderNode = node;
    audioRecorderContext = ctx;
    micStream = stream;
    activeInputDeviceId = inputDeviceIdOf(stream);
    healInputPriority(stream);
    clearTimeout(watchdog);
    setTimeout(() => finishAudioStart(null), AUDIO_WARMUP_MS);
  }).catch((err) => {
    console.error("Audio recorder failed to start:", err);
    finishAudioStart(err && err.name ? `${err.name} — ${err.message}` : String(err));
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
const outputMuteButton = document.getElementById("outputMuteButton");
const pttToggle = document.getElementById("pttToggle");
const simulToggle = document.getElementById("simulToggle");

simulToggle.checked = simulMode;

function applySimulUi() {
  const glossaryBtn = document.getElementById("openGlossary");
  const langSelector = document.querySelector(".language-selector");
  const autoDetectLabel = document.getElementById("autoDetectLabel");
  const sourceLangWrapper = document.getElementById("sourceLangWrapper");
  const bidiIcon = document.getElementById("bidiIcon");
  const glossarySimulNote = document.getElementById("glossarySimulNote");
  if (simulMode) {
    sourceLangWrapper.style.display = "none";
    autoDetectLabel.style.display = "";
    if (glossarySimulNote) glossarySimulNote.style.display = "";
  } else {
    sourceLangWrapper.style.display = "";
    autoDetectLabel.style.display = "none";
    if (glossarySimulNote) glossarySimulNote.style.display = "none";
  }
  bidiIcon.style.display = simulMode ? "none" : "";
}
applySimulUi();

simulToggle.addEventListener("change", () => {
  simulMode = simulToggle.checked;
  localStorage.setItem(SIMUL_KEY, simulMode ? "true" : "false");
  // The two modes are mutually exclusive and there is nothing else to fall
  // back to, so turning Simul off returns you to a conversation.
  convoMode = !simulMode;
  rebuildTargetDropdown();
  // Turning Simul off brings a one-way target back opposite a source that was
  // hidden while it was on, so this is where the two most often collide.
  separateLanguages(sourceLangSelect, null);
  applySimulUi();
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

/**
 * One-line description of what the session about to open will do.
 *
 * Simul auto-detects the source language, so naming the source dropdown there
 * would be a lie — that dropdown is hidden in Simul precisely because its value
 * is ignored. Conversation goes both ways, so it gets no arrow direction.
 */
function sessionDescription() {
  const { src, tgt } = getLanguageNames();
  return simulMode
    ? `Any language → ${tgt} (Simultaneous)`
    : `${src} ⇄ ${tgt} (Conversation)`;
}

// Ramp constant for the output mute, in seconds. This is setTargetAtTime's
// time constant, so the audible settle is roughly three times it: fast enough
// to feel instant, slow enough that cutting a waveform mid-cycle — which is
// what a mute reached for mid-sentence always does — is not heard as a click.
const OUTPUT_MUTE_RAMP_SEC = 0.015;
// Leaves the ramp time to finish before the queued audio is dropped, so a mute
// lands as a short fade rather than as a cut.
const OUTPUT_FLUSH_DELAY_MS = 80;
let outputFlushTimer = null;

/** Push `outputMuted` onto the gain node, if a player is up yet. */
function applyOutputGain() {
  if (!audioPlayerGain || !audioPlayerContext) return;
  const t = audioPlayerContext.currentTime;
  audioPlayerGain.gain.cancelScheduledValues(t);
  audioPlayerGain.gain.setTargetAtTime(outputMuted ? 0 : 1, t, OUTPUT_MUTE_RAMP_SEC);
}

function setOutputMuted(muted) {
  outputMuted = muted;
  applyOutputGain();
  clearTimeout(outputFlushTimer);
  if (muted) {
    // Whatever is already queued is unwanted too, so drop it once the fade has
    // played. Arriving chunks are refused from here on, so the worklet's buffer
    // stays empty for as long as the mute lasts.
    outputFlushTimer = setTimeout(() => {
      if (audioPlayerNode) audioPlayerNode.port.postMessage({ command: "endOfAudio" });
    }, OUTPUT_FLUSH_DELAY_MS);
  }
  updateAudioControls();
}

/**
 * Paint both audio controls from the current state.
 *
 * The Start button doubles as the microphone control once audio is running: in
 * always-on mode there is nothing else left to click, and a mic that cannot be
 * silenced is a hazard in a room left connected. The speaker button sits next
 * to it and answers a different question, so it is always live: before Start,
 * after it, and in push-to-talk, where the microphone is the Start button's
 * job and the output is all that is left to mute.
 *
 * The labels say what is *on* rather than what a click would do: with two
 * near-identical buttons side by side, "Mute" does not say mute what. Icon and
 * colour carry the state; aria-pressed and the tooltip carry the action.
 */
function updateAudioControls() {
  outputMuteButton.textContent = outputMuted ? "Sound off" : "Sound on";
  outputMuteButton.classList.toggle("muted", outputMuted);
  outputMuteButton.setAttribute("aria-pressed", String(outputMuted));
  outputMuteButton.title = outputMuted
    ? "Play the translated speech out loud again"
    : "Mute the translated speech";

  if (pttMode) return; // push-to-talk owns the Start button's label and colour
  if (!micRunning) {
    startAudioButton.textContent = "Start";
    startAudioButton.classList.remove("muted");
    startAudioButton.removeAttribute("aria-pressed");
    startAudioButton.removeAttribute("title");
    return;
  }
  startAudioButton.textContent = micMuted ? "Mic off" : "Mic on";
  startAudioButton.classList.toggle("muted", micMuted);
  startAudioButton.setAttribute("aria-pressed", String(micMuted));
  startAudioButton.title = micMuted
    ? "Send your voice to the translator again"
    : "Stop sending your voice to the translator";
}

// Always-on mode: click Start, then the same button mutes/unmutes the mic.
startAudioButton.addEventListener("click", () => {
  if (pttMode) return;
  if (micRunning) {
    // Only stop sending frames — the mic stream stays open so unmuting is
    // instant and never re-prompts for permission.
    micMuted = !micMuted;
    is_audio = !micMuted;
    updateAudioControls();
    addSystemMessage(micMuted ? "Microphone muted" : "Microphone unmuted");
    return;
  }
  startAudioButton.disabled = true;
  initAudioIfNeeded();
  is_audio = true;
});

// The translated speech, silenced without touching what is being sent up: the
// session keeps translating and the transcript keeps filling, this listener
// just stops hearing it.
outputMuteButton.addEventListener("click", () => {
  setOutputMuted(!outputMuted);
  addSystemMessage(
    outputMuted ? "Translation audio muted" : "Translation audio unmuted"
  );
});

// PTT toggle
pttToggle.addEventListener("change", () => {
  pttMode = pttToggle.checked;
  if (pttMode) {
    // PTT owns the button's label and colour, so drop the mic-mute role. The
    // speaker button is untouched — output mute is orthogonal to how the
    // microphone is gated, and stays available in both modes.
    micRunning = false;
    micMuted = false;
    startAudioButton.classList.remove("muted");
    startAudioButton.removeAttribute("aria-pressed");
    startAudioButton.removeAttribute("title");
    startAudioButton.classList.add("ptt-mode");
    startAudioButton.disabled = !audioInitialized;
    startAudioButton.textContent = "Hold to Talk";
    if (!audioInitialized) {
      initAudioIfNeeded();
      is_audio = true;
    } else {
      is_audio = false;
    }
    updateAudioControls();
  } else {
    startAudioButton.classList.remove("ptt-mode");
    startAudioButton.classList.remove("ptt-active");
    is_audio = false;
    audioInitialized = false;
    micRunning = false;
    micMuted = false;
    updateAudioControls();
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
 * Audio device preferences (per browser, stored in localStorage)
 *
 * Each kind keeps a *ranked* list of devices the user has picked, most recent
 * first. Whichever entry is highest-ranked among the devices currently attached
 * wins — so plugging a favourite headset back in reclaims it automatically,
 * and unplugging it drops to the next choice rather than to the system default.
 *
 * An entry records both the deviceId and the label. The id is the precise
 * handle but a perishable one: the browser re-salts it whenever site
 * permissions are cleared, and some devices return with a new id after a
 * replug. The label survives that, so it is the fallback — and whenever a
 * label rescues a lookup, the fresh id is written back over the stale one.
 */
const AUDIO_INPUT_KEY = "live-translator.audio.inputPriority";
const AUDIO_OUTPUT_KEY = "live-translator.audio.outputPriority";
const MAX_PRIORITY_ENTRIES = 10;

// Superseded single-device keys, still read once to migrate existing browsers.
const LEGACY_KEYS = {
  [AUDIO_INPUT_KEY]: ["live-translator.audio.inputDeviceId", "live-translator.audio.inputLabel"],
  [AUDIO_OUTPUT_KEY]: ["live-translator.audio.outputDeviceId", "live-translator.audio.outputLabel"],
};

/** The ranked list for one device kind, best first. Entries are {id, label}. */
function getPriority(key) {
  try {
    const list = JSON.parse(localStorage.getItem(key) || "null");
    if (Array.isArray(list)) {
      return list.filter((e) => e && typeof e === "object" && (e.id || e.label));
    }
  } catch {
    // Corrupt JSON is not worth surfacing — fall through and re-derive.
  }
  const [idKey, labelKey] = LEGACY_KEYS[key];
  const id = localStorage.getItem(idKey) || "";
  const label = localStorage.getItem(labelKey) || "";
  return id || label ? [{ id, label }] : [];
}

function setPriority(key, list) {
  if (list.length) {
    localStorage.setItem(key, JSON.stringify(list.slice(0, MAX_PRIORITY_ENTRIES)));
  } else {
    localStorage.removeItem(key);
  }
  for (const k of LEGACY_KEYS[key]) localStorage.removeItem(k);
}

// Upgrade the old single-device keys once, at load, so there is exactly one
// representation on disk from here on.
for (const key of [AUDIO_INPUT_KEY, AUDIO_OUTPUT_KEY]) {
  if (!localStorage.getItem(key) && LEGACY_KEYS[key].some((k) => localStorage.getItem(k))) {
    setPriority(key, getPriority(key));
  }
}

/** Same physical device? Ids are authoritative; labels cover a re-salted id. */
function sameDevice(a, b) {
  if (a.id && b.id && a.id === b.id) return true;
  return !!(a.label && a.label === b.label);
}

/** Move a device to the top of its ranked list. */
function promoteDevice(key, entry) {
  setPriority(key, [entry, ...getPriority(key).filter((e) => !sameDevice(e, entry))]);
}

/**
 * The best currently-attached device for a kind, or null for "system default".
 *
 * Only usable once labels are visible; before microphone permission is granted
 * `enumerateDevices()` returns blank labels and ids, so callers must be ready
 * for a null here to mean "don't know yet" rather than "nothing matches".
 */
function pickPreferred(key, devices) {
  const list = getPriority(key);
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const byId = entry.id && devices.find((d) => d.deviceId === entry.id);
    const match = byId || (entry.label && devices.find((d) => d.label === entry.label));
    if (!match) continue;
    if (!byId) {
      // The label rescued a stale id — write the current one back in place,
      // keeping the entry's rank.
      list[i] = { id: match.deviceId, label: match.label || entry.label };
      setPriority(key, list);
    }
    return match;
  }
  return null;
}

/** Repair the top-ranked entry's id from the stream we actually got. */
function healInputPriority(stream) {
  const track = stream && stream.getAudioTracks()[0];
  const list = getPriority(AUDIO_INPUT_KEY);
  if (!track || !list.length) return; // never pin an implicit default
  const id = track.getSettings().deviceId;
  if (!id) return;
  const entry = { id, label: track.label || list[0].label || "" };
  // Only rewrite the entry this stream corresponds to; a fallback to some
  // lower-ranked device must not promote it over the user's real first choice.
  const idx = list.findIndex((e) => sameDevice(e, entry));
  if (idx === -1) return;
  list[idx] = entry;
  setPriority(AUDIO_INPUT_KEY, list);
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

  fillDeviceSelect(audioInputSelect, inputs, "Microphone", AUDIO_INPUT_KEY);
  fillDeviceSelect(audioOutputSelect, outputs, "Speaker", AUDIO_OUTPUT_KEY);
}

/** Rebuild a device dropdown, selecting the best-ranked attached device. */
function fillDeviceSelect(select, devices, noun, key) {
  select.innerHTML = "";
  const dflt = document.createElement("option");
  dflt.value = "";
  dflt.textContent = "System Default";
  select.appendChild(dflt);

  const preferred = pickPreferred(key, devices);
  for (const d of devices) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `${noun} (${d.deviceId.slice(0, 8)}...)`;
    // The visible text falls back to a truncated id when labels are hidden;
    // keep the real label separate so we never persist that placeholder.
    opt.dataset.label = d.label || "";
    if (d === preferred) opt.selected = true;
    select.appendChild(opt);
  }
}

/** The label of the option currently chosen in a device dropdown. */
function selectedLabel(select) {
  const opt = select.selectedOptions[0];
  return opt ? opt.dataset.label || "" : "";
}

/**
 * Record an explicit pick. Choosing a real device ranks it first; choosing
 * "System Default" is a deliberate opt-out, so it clears the list rather than
 * being outranked by an earlier favourite the moment one gets plugged in.
 */
function onDevicePicked(key, select) {
  if (select.value) promoteDevice(key, { id: select.value, label: selectedLabel(select) });
  else setPriority(key, []);
}

/**
 * Record a pick and act on it straight away.
 *
 * Persisting alone was not enough: the running pipeline kept reading the old
 * device until the app was reloaded, so the dropdown looked like it had done
 * something it had not. `restartRecorder`/`restartPlayer` no-op while audio is
 * stopped, in which case the next Start reads the same ranking anyway.
 *
 * The in-flight latch is shared with the devicechange handler so a plug event
 * and a manual pick cannot rebuild the same pipeline at the same time.
 */
async function applyDevicePick(key, select, restart, noun) {
  onDevicePicked(key, select);
  if (deviceSwitchInFlight) return;
  deviceSwitchInFlight = true;
  try {
    await restart();
  } catch (err) {
    console.error(`Failed to switch ${noun}:`, err);
    addSystemMessage(`Could not switch ${noun}.`);
  } finally {
    deviceSwitchInFlight = false;
  }
}

audioInputSelect.addEventListener("change", () => {
  applyDevicePick(AUDIO_INPUT_KEY, audioInputSelect, restartRecorder, "microphone");
});

audioOutputSelect.addEventListener("change", () => {
  applyDevicePick(AUDIO_OUTPUT_KEY, audioOutputSelect, restartPlayer, "speaker");
});

/** deviceId the granted stream is really reading from ("" if unknown). */
function inputDeviceIdOf(stream) {
  const track = stream && stream.getAudioTracks()[0];
  return (track && track.getSettings().deviceId) || "";
}

/** Rebuild the mic pipeline against the current preference ranking. */
async function restartRecorder() {
  if (!audioRecorderContext) return;
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  await audioRecorderContext.close();
  const [node, ctx, stream] = await startAudioRecorderWorklet(
    audioRecorderHandler, getPriority(AUDIO_INPUT_KEY)
  );
  audioRecorderNode = node;
  audioRecorderContext = ctx;
  micStream = stream;
  activeInputDeviceId = inputDeviceIdOf(stream);
  healInputPriority(stream);
}

/** Rebuild the playback pipeline against the current preference ranking. */
async function restartPlayer() {
  if (!audioPlayerContext) return;
  await audioPlayerContext.close();
  const [node, ctx, sinkId, gain] = await startAudioPlayerWorklet(getPriority(AUDIO_OUTPUT_KEY));
  audioPlayerNode = node;
  audioPlayerContext = ctx;
  activeOutputDeviceId = sinkId;
  audioPlayerGain = gain;
  // Switching speakers must not un-mute the output.
  applyOutputGain();
}

document.getElementById("applyAudio").addEventListener("click", () => {
  audioOverlay.classList.add("hidden");
  // Devices already switched when they were picked; the voice is all that is
  // left, and it is baked into the Live session's config, so a new choice only
  // applies once we reconnect.
  if (getVoice() !== activeVoice) reconnectWithNewLanguage();
});

document.getElementById("closeAudio").addEventListener("click", () => {
  audioOverlay.classList.add("hidden");
});

audioOverlay.addEventListener("click", (e) => {
  if (e.target === audioOverlay) audioOverlay.classList.add("hidden");
});

/**
 * Re-pick devices whenever the attached set changes.
 *
 * Plugging in a device the user ranks above the one in use switches to it, and
 * losing the device in use drops to the next-best rather than to the system
 * default. Nothing happens while audio is stopped — the next Start reads the
 * same ranking anyway.
 *
 * Browsers fire `devicechange` several times for a single physical event (and
 * once more after switching, since claiming a device perturbs the list), so
 * the handler is debounced and re-entrancy is latched out.
 */
const DEVICE_CHANGE_DEBOUNCE_MS = 500;
let deviceChangeTimer = null;
let deviceSwitchInFlight = false;

async function onDeviceChange() {
  if (!audioOverlay.classList.contains("hidden")) populateAudioDevices();
  if (deviceSwitchInFlight || (!audioRecorderContext && !audioPlayerContext)) return;

  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const preferredIn = pickPreferred(AUDIO_INPUT_KEY, devices.filter(d => d.kind === "audioinput"));
  const preferredOut = pickPreferred(AUDIO_OUTPUT_KEY, devices.filter(d => d.kind === "audiooutput"));
  // A null pick means no ranked device is attached; the pipeline is already on
  // the system default in that case, so there is nothing to move to.
  const swapIn = preferredIn && preferredIn.deviceId !== activeInputDeviceId;
  const swapOut = preferredOut && preferredOut.deviceId !== activeOutputDeviceId;
  if (!swapIn && !swapOut) return;

  deviceSwitchInFlight = true;
  try {
    if (swapIn) {
      await restartRecorder();
      addSystemMessage(`Switched microphone to ${preferredIn.label || "preferred device"}`);
    }
    if (swapOut) {
      await restartPlayer();
      addSystemMessage(`Switched speaker to ${preferredOut.label || "preferred device"}`);
    }
  } catch (err) {
    console.error("Failed to switch audio device:", err);
  } finally {
    deviceSwitchInFlight = false;
  }
}

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    clearTimeout(deviceChangeTimer);
    deviceChangeTimer = setTimeout(onDeviceChange, DEVICE_CHANGE_DEBOUNCE_MS);
  });
}

/**
 * Translation voice (per browser)
 *
 * The prebuilt voice the Live API speaks the translation in. The list and the
 * default come from /api/languages so the server stays the single source of
 * truth; the server also re-validates, since an unknown voice name makes the
 * upstream connect fail outright.
 *
 * The voice is fixed for the lifetime of a Live session, so changing it takes
 * effect on the next connection.
 */
const VOICE_KEY = "live-translator.voice";
const voiceSelect = document.getElementById("voiceSelect");
let activeVoice = null; // voice the current Live session was opened with

function getVoice() {
  return voiceSelect.value || localStorage.getItem(VOICE_KEY) || "";
}

function populateVoiceSelect(voices, defaultVoice) {
  if (!voices) return;
  const saved = localStorage.getItem(VOICE_KEY);
  const chosen = saved && saved in voices ? saved : defaultVoice;
  voiceSelect.innerHTML = "";
  for (const [name, tone] of Object.entries(voices)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = `${name} — ${tone}`;
    if (name === chosen) opt.selected = true;
    voiceSelect.appendChild(opt);
  }
}

voiceSelect.addEventListener("change", () => {
  localStorage.setItem(VOICE_KEY, voiceSelect.value);
});

function updateModelDisplay() {
  const el = document.getElementById("modelNameDisplay");
  if (el) el.textContent = (simulMode ? window._simulModelName : window._modelName) || "";
}

document.getElementById("openOverlay").addEventListener("click", () => {
  window.open("/caption", "live-translator-caption");
});

document.getElementById("openAudio").addEventListener("click", async () => {
  audioOverlay.classList.remove("hidden");
  await populateAudioDevices();
  updateModelDisplay();
});
