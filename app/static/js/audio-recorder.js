/**
 * Audio Recorder Worklet
 */

import { candidateIds, isPermissionError } from "./device-lookup.js";

const RESUME_TIMEOUT_MS = 1500;

// The browser's echo canceller is the only thing between the translated
// speech coming out of the speakers and the mic picking it back up, so ask
// for it explicitly instead of relying on the spec default — a default that
// is true today in every browser we target, but is not ours to depend on.
// AGC is off on purpose: it flattens the speaker's dynamics, and the system
// instruction asks the model to preserve their tone and urgency.
const AUDIO_PROCESSING = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
};

function micConstraints(deviceId) {
  return {
    audio: { channelCount: 1, deviceId: { exact: deviceId }, ...AUDIO_PROCESSING },
  };
}

/**
 * Open the highest-ranked usable mic from *prefs* (best first), else the default.
 *
 * Each entry is tried by id then by label, in rank order, so a lower-ranked
 * device is only reached once every better one has actually failed to open.
 * A default mic beats failing startup outright, so an exhausted list still
 * yields a stream — but a permission refusal aborts immediately, since every
 * remaining attempt would fail the same way and the caller should say so.
 */
async function getMicStream(prefs) {
  const base = { audio: { channelCount: 1, ...AUDIO_PROCESSING } };
  if (!prefs || !prefs.length) return navigator.mediaDevices.getUserMedia(base);

  for (const id of await candidateIds("audioinput", prefs)) {
    try {
      return await navigator.mediaDevices.getUserMedia(micConstraints(id));
    } catch (err) {
      if (isPermissionError(err)) throw err;
      console.warn("Preferred mic unusable:", id, err.name, err.message);
    }
  }

  console.warn("No preferred mic available, falling back to the default");
  return navigator.mediaDevices.getUserMedia(base);
}

export async function startAudioRecorderWorklet(audioRecorderHandler, devicePrefs) {
  const audioRecorderContext = new AudioContext({ sampleRate: 16000 });
  // iOS Safari starts the context "suspended"; without resuming, the worklet
  // never runs and no mic PCM is produced. Resume within the Start gesture.
  //
  // Deliberately not a bare await: in Chrome, resume() does not settle while
  // the document is hidden or fully occluded (e.g. the fullscreen caption
  // window is covering this one), which would hang startup indefinitely.
  // resumeAudioContexts() in app.js retries on the next gesture or
  // visibilitychange, so giving up on the promise here costs nothing.
  if (audioRecorderContext.state === "suspended") {
    await Promise.race([
      audioRecorderContext.resume().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, RESUME_TIMEOUT_MS)),
    ]);
  }
  const workletURL = new URL("./pcm-recorder-processor.js", import.meta.url);
  await audioRecorderContext.audioWorklet.addModule(workletURL);

  const micStream = await getMicStream(devicePrefs);
  const source = audioRecorderContext.createMediaStreamSource(micStream);

  const audioRecorderNode = new AudioWorkletNode(
    audioRecorderContext,
    "pcm-recorder-processor"
  );

  source.connect(audioRecorderNode);
  audioRecorderNode.port.onmessage = (event) => {
    const pcmData = convertFloat32ToPCM(event.data);
    audioRecorderHandler(pcmData);
  };
  return [audioRecorderNode, audioRecorderContext, micStream];
}

function convertFloat32ToPCM(inputData) {
  const pcm16 = new Int16Array(inputData.length);
  for (let i = 0; i < inputData.length; i++) {
    pcm16[i] = inputData[i] * 0x7fff;
  }
  return pcm16.buffer;
}
