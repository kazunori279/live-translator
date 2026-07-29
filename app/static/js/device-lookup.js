/**
 * Resolving a ranked list of preferred devices to concrete deviceIds.
 *
 * A `deviceId` is only stable while the browser's per-origin salt and the
 * device itself stay put — clearing site permissions re-salts it, and some
 * devices come back with a new id after a replug. The label ("Yeti Stereo
 * Microphone") survives both, so every preference carries one as a fallback.
 */

/**
 * deviceIds worth attempting for *prefs* (best first), in strict rank order.
 *
 * For each entry the saved id comes first — it needs no permission and no
 * enumeration — followed by whatever id currently carries that entry's label.
 * Ids already offered are not repeated, so the caller can just try each in
 * turn. Entries resolve to nothing when the page has no microphone permission
 * yet: `enumerateDevices()` blanks every label until then, leaving only the
 * saved ids to go on.
 */
export async function candidateIds(kind, prefs) {
  const wanted = (prefs || []).filter((p) => p && (p.id || p.label));
  if (!wanted.length) return [];

  let devices = null; // enumerated at most once, and only if a label needs it
  const ids = [];
  for (const pref of wanted) {
    if (pref.id && !ids.includes(pref.id)) ids.push(pref.id);
    if (!pref.label) continue;
    if (devices === null) devices = await enumerate();
    const match = devices.find((d) => d.kind === kind && d.label === pref.label);
    if (match && match.deviceId && !ids.includes(match.deviceId)) {
      ids.push(match.deviceId);
    }
  }
  return ids;
}

/**
 * True for failures that retrying with a different device cannot fix — the
 * user denied access, or the context is insecure.
 */
export function isPermissionError(err) {
  return !!err && (err.name === "NotAllowedError" || err.name === "SecurityError");
}

async function enumerate() {
  try {
    return await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
}
