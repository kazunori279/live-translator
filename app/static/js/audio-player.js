/**
 * Audio Player Worklet
 */

import { candidateIds } from "./device-lookup.js";

/**
 * Route output to the highest-ranked usable speaker in *prefs*, else leave it
 * on the system default.
 *
 * A device that has gone away must not be fatal here: routing is a preference,
 * and throwing would take the whole player down and kill playback outright.
 * Returns the deviceId actually in use ("" for the system default).
 */
async function applySinkId(audioContext, prefs) {
  if (!audioContext.setSinkId) return "";
  for (const id of await candidateIds("audiooutput", prefs)) {
    try {
      await audioContext.setSinkId(id);
      return id;
    } catch (err) {
      console.warn("Preferred speaker unusable:", id, err.name, err.message);
    }
  }
  return "";
}

export async function startAudioPlayerWorklet(devicePrefs) {
  const audioContext = new AudioContext({ sampleRate: 24000 });
  // iOS Safari starts the context "suspended"; resume so playback is audible.
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  const sinkId = await applySinkId(audioContext, devicePrefs);
  const workletURL = new URL('./pcm-player-processor.js', import.meta.url);
  await audioContext.audioWorklet.addModule(workletURL);

  const audioPlayerNode = new AudioWorkletNode(audioContext, 'pcm-player-processor');
  // Output mute rides on a gain node rather than on the worklet, so it can be
  // ramped. Dropping straight to zero on a waveform mid-cycle is an audible
  // click, and the mute is most often reached for while the model is speaking.
  const gainNode = audioContext.createGain();
  audioPlayerNode.connect(gainNode);
  gainNode.connect(audioContext.destination);

  return [audioPlayerNode, audioContext, sinkId, gainNode];
}
