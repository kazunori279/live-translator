/**
 * Switchboard. Owns no audio and no socket.
 *
 * An MV3 service worker is torn down after ~30s idle and restarted on the next
 * event, so nothing here may hold state in a module variable across events —
 * `chrome.storage.session` is the only memory it has. Everything with a
 * lifetime (streams, AudioContexts, WebSockets) lives in the offscreen
 * document instead, whose lifetime is independent of this one.
 *
 * What this file does own is the two things only a service worker can do:
 * minting a tab-capture stream id, and creating the offscreen document.
 */

import { loadSettings } from "./lib/settings.js";
import { ensureGlossary } from "./lib/glossary.js";

const OFFSCREEN_URL = "offscreen.html";

// The action click is what grants `activeTab` on the current tab, and
// `tabCapture` is gated on exactly that grant. Opening the side panel has to
// happen inside the click handler too — `sidePanel.open()` requires a user
// gesture and a message from the panel is not one.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.warn("Could not open the side panel:", err);
  }
  // Remember which tab the user invoked us on. The side panel's Start button
  // needs a target tab, and by then the active tab may well be a different one
  // — the user clicks through to the panel, or switches away while it loads.
  await chrome.storage.session.set({ invokedTabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "sw") return false;
  handle(msg, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async reply
});

async function handle(msg, sender) {
  switch (msg.type) {
    case "start":
      return start();
    case "stop":
      return stop();
    case "getState":
      return getState();
    case "caption":
      // Relayed from the offscreen document, which has no tab of its own.
      await sendToCaptions(msg.payload);
      return {};
    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

async function getState() {
  const { running = false, capturedTabId = null } = await chrome.storage.session.get([
    "running",
    "capturedTabId",
  ]);
  return { running, capturedTabId };
}

async function targetTab() {
  const { invokedTabId } = await chrome.storage.session.get("invokedTabId");
  if (invokedTabId != null) {
    try {
      return await chrome.tabs.get(invokedTabId);
    } catch {
      // The tab closed since the icon was clicked; fall through to the active
      // one, which will simply fail the activeTab check with a clear message.
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error("No tab to capture.");
  return active;
}

async function start() {
  const settings = await loadSettings();
  if (!settings.tabEnabled && !settings.micEnabled) {
    throw new Error("Enable at least one direction first.");
  }

  let streamId = null;
  let tabId = null;
  if (settings.tabEnabled) {
    const tab = await targetTab();
    tabId = tab.id;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (err) {
      // The one failure users actually hit: the extension was never invoked on
      // this tab, or the invocation lapsed when the tab navigated.
      throw new Error(
        `Click the Live Translator toolbar icon on the tab you want to translate, ` +
          `then press Start again. (${err.message})`
      );
    }
  }

  // Fetched here rather than in the offscreen document so a missing host
  // permission surfaces as a Start-button error the user can act on, instead
  // of a silent empty glossary inside a context with no UI.
  const glossary = await ensureGlossary(settings.backendUrl);

  await ensureOffscreen();
  const started = await toOffscreen({
    type: "start",
    streamId,
    settings,
    glossary,
  });
  if (!started.ok) throw new Error(started.error);

  await chrome.storage.session.set({ running: true, capturedTabId: tabId });
  await ensureCaptionTab(settings);
  return { capturedTabId: tabId };
}

/** Are subtitles wanted by either of the directions that are actually running? */
function wantsCaptions(settings) {
  return (
    (settings.tabEnabled && settings.tabCaptions) || (settings.micEnabled && settings.micCaptions)
  );
}

/**
 * Put the overlay on a page and remember which one, so the offscreen document's
 * transcripts have somewhere to go.
 *
 * The captured tab is the obvious target, but the microphone direction can run
 * on its own, with nothing captured. Its subtitles still have to land
 * somewhere, and the tab the toolbar icon was clicked on is both the sensible
 * choice and the only one `activeTab` lets us inject into.
 */
async function ensureCaptionTab(settings) {
  if (!wantsCaptions(settings)) return;
  const existing = (await chrome.storage.session.get("captionTabId")).captionTabId;
  if (existing != null) return;
  const { capturedTabId } = await chrome.storage.session.get("capturedTabId");
  const tabId = capturedTabId ?? (await targetTab().catch(() => null))?.id ?? null;
  if (tabId == null) return;
  await chrome.storage.session.set({ captionTabId: tabId });
  await injectCaptions(tabId);
}

// Both subtitle switches apply mid-session — the offscreen document just stops
// forwarding — but turning one on when neither was on at Start means there is
// no overlay to forward to yet. A storage change wakes this worker, so the
// injection can happen then rather than costing a reconnect.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || (!changes.tabCaptions && !changes.micCaptions)) return;
  const { running } = await chrome.storage.session.get("running");
  if (running) await ensureCaptionTab(await loadSettings());
});

/**
 * Message the offscreen document, tolerating a document that exists but whose
 * module has not finished evaluating.
 *
 * `createDocument()` resolves once the document is created, which is a moment
 * earlier than its module script registering the message listener — and until
 * it does, `sendMessage` rejects with "Receiving end does not exist".
 */
async function toOffscreen(message, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: "offscreen", ...message });
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function stop() {
  if (await hasOffscreen()) {
    await toOffscreen({ type: "stop" }).catch(() => {});
    await chrome.offscreen.closeDocument();
  }
  await sendToCaptions({ type: "teardown" }).catch(() => {});
  await chrome.storage.session.set({
    running: false,
    capturedTabId: null,
    captionTabId: null,
  });
  return {};
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // USER_MEDIA covers both the tab stream and the microphone; AUDIO_PLAYBACK
    // covers the translated voice and the passthrough that makes the captured
    // tab audible again. Both reasons keep the document alive indefinitely,
    // which is the whole point of putting the engine there.
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification:
      "Capture tab and microphone audio, stream it to the translation relay, " +
      "and play the translated speech back.",
  });
}

async function injectCaptions(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/captions.js"],
    });
  } catch (err) {
    // Chrome's own pages, the Web Store, and PDF viewers refuse injection.
    // Captions are a nicety; the side panel still shows the transcript.
    console.warn("Captions unavailable on this page:", err.message);
  }
}

async function sendToCaptions(payload) {
  const { captionTabId } = await chrome.storage.session.get("captionTabId");
  if (captionTabId == null) return;
  try {
    await chrome.tabs.sendMessage(captionTabId, { target: "captions", ...payload });
  } catch {
    // No content script on that tab (injection refused, or the page navigated
    // out from under it). Nothing to do — the side panel has the transcript.
  }
}

// A captured tab that goes away takes its stream with it, and the offscreen
// document would sit there holding a dead MediaStream.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { capturedTabId, captionTabId } = await chrome.storage.session.get([
    "capturedTabId",
    "captionTabId",
  ]);
  // A microphone-only run outlives the page it was subtitling; forget the
  // overlay and keep going.
  if (tabId === captionTabId) await chrome.storage.session.set({ captionTabId: null });
  if (tabId === capturedTabId) await stop();
});
