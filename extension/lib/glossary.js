/**
 * Glossary handling, ported from `app/static/js/app.js`.
 *
 * The relay already rewrites glossary terms in the transcripts it sends
 * (`_TranscriptRewriter` in `app/main.py`), including across the streamed
 * fragment boundaries a client cannot see. `applyDisplayMap` here is the same
 * belt-and-braces pass the web app keeps: harmless when the server got there
 * first, and the only thing standing between a raw target string and the
 * caption when talking to an older relay.
 */

export const MAX_GLOSSARY_ENTRIES = 1000;
export const MAX_GLOSSARY_BYTES = 256 * 1024;

export function normalizeEntry(p) {
  if (!p || typeof p.source !== "string" || typeof p.target !== "string") return null;
  const transcription =
    typeof p.transcription === "string" && p.transcription.length
      ? p.transcription
      : p.target;
  return { source: p.source, target: p.target, transcription };
}

export function parseGlossaryCsv(text) {
  const pairs = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
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

export function buildDisplayMap(pairs) {
  const map = [];
  for (const p of pairs || []) {
    if (p.transcription && p.transcription !== p.target) map.push([p.target, p.transcription]);
  }
  // Longer targets first, so a longer match wins over a shorter prefix.
  map.sort((a, b) => b[0].length - a[0].length);
  return map;
}

export function applyDisplayMap(text, displayMap) {
  if (!text || !displayMap || !displayMap.length) return text;
  let out = text.normalize("NFKC");
  for (const [from, to] of displayMap) {
    const nFrom = from.normalize("NFKC");
    if (out.includes(nFrom)) out = out.split(nFrom).join(to);
  }
  return out;
}

/** Spaces between CJK characters that the model's transcript sometimes carries. */
export function cleanCJKSpaces(text) {
  const cjk = /[　-〿぀-ゟ゠-ヿ一-龯＀-￯]/;
  return text.replace(/(\S)\s+(?=(\S))/g, (match, a, b) =>
    cjk.test(a) && cjk.test(b) ? a : match
  );
}

/**
 * The glossary, seeding from the relay's baked-in default the first time.
 *
 * A null in storage means "never seeded"; an empty array means the user
 * deliberately cleared it, and must not be re-seeded over.
 */
export async function ensureGlossary(backendUrl) {
  const { glossary } = await chrome.storage.local.get("glossary");
  if (Array.isArray(glossary)) return glossary;
  try {
    const resp = await fetch(new URL("/api/glossary/defaults", backendUrl));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const { pairs } = await resp.json();
    const seeded = pairs.map(normalizeEntry).filter(Boolean);
    await chrome.storage.local.set({ glossary: seeded });
    return seeded;
  } catch (err) {
    console.warn("Could not seed the default glossary:", err);
    return [];
  }
}
