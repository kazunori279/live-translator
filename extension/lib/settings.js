/**
 * Extension settings, in `chrome.storage.local`.
 *
 * The web app keeps the same preferences in `localStorage`, which is
 * unreachable from a service worker and unshared between an offscreen document
 * and a side panel. `chrome.storage.local` is the one store every extension
 * context can read, so everything lives here — including the glossary, which
 * would otherwise have to be re-sent between contexts on every session.
 */

// The deployed relay. Both regions run the same image but hold their session
// state in memory, so a conversation cannot straddle them — hence a single
// chosen endpoint rather than a fallback list.
export const BACKENDS = {
  "us-central1": "https://live-translation-761793285222.us-central1.run.app",
  "asia-northeast1": "https://live-translation-761793285222.asia-northeast1.run.app",
  local: "http://localhost:8000",
};

export const DEFAULTS = {
  backendUrl: BACKENDS["us-central1"],
  voice: "", // "" means "whatever /api/languages calls the default"
  glossary: null, // null = not seeded yet; [] = deliberately empty
  // tab → you. Always the simultaneous-translation model: a tab plays whoever
  // it plays, and naming a source language up front is a promise the listener
  // cannot keep. Auto-detect is the only setting that fits, so it is not
  // offered as a choice — which is also why there is no tab source language.
  tabEnabled: true,
  tabTarget: "en",
  tabCaptions: true,
  // you → them. One-way agent mode: the source is known (it is you), so the
  // glossary applies, which it cannot in simul.
  micEnabled: false,
  micSource: "en",
  micTarget: "ja",
  // Off by default: with both directions running, subtitling your own speech as
  // well as theirs puts two rolling lines on the page at once, which is a
  // deliberate choice rather than something to walk into.
  micCaptions: false,
  // Original tab audio while a translation is speaking. 1.0 disables ducking.
  duckLevel: 0.15,
  duplexGate: true,
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get([...Object.keys(DEFAULTS), "captions"]);
  // Subtitles used to be one switch for both directions. Carry that choice over
  // to the tab direction instead of silently turning them back on for someone
  // who had switched them off.
  if ("captions" in stored && !("tabCaptions" in stored)) stored.tabCaptions = stored.captions;
  delete stored.captions;
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

/** `wss://host/ws/...` for an https backend, `ws://` for a local http one. */
export function webSocketUrl(backendUrl, path, params) {
  const base = new URL(backendUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(path.replace(/^\//, ""), base.href.replace(/\/?$/, "/"));
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Match pattern covering one backend origin, for `chrome.permissions`.
 *
 * Deliberately built from the hostname rather than from `origin`: a match
 * pattern has no port component, so `http://localhost:8000/*` is not merely
 * over-specific but invalid, and `permissions.request` throws on it.
 * `http://localhost/*` is the pattern that covers localhost on any port.
 */
export function originPattern(backendUrl) {
  let url;
  try {
    url = new URL(backendUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  return `${url.protocol}//${url.hostname}/*`;
}
