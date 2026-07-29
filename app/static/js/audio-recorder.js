/**
 * Audio Recorder Worklet
 */

const RESUME_TIMEOUT_MS = 1500;

/** getUserMedia, falling back to the default device if a saved one is gone. */
async function getMicStream(deviceId) {
  const base = { audio: { channelCount: 1 } };
  if (!deviceId) return navigator.mediaDevices.getUserMedia(base);
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, deviceId: { exact: deviceId } },
    });
  } catch (err) {
    // A saved device can vanish (unplugged, or grabbed by another app), which
    // makes `deviceId: {exact}` throw OverconstrainedError. Prefer a working
    // default mic over failing startup outright.
    console.warn("Saved mic unavailable, using default:", err.name, err.message);
    return navigator.mediaDevices.getUserMedia(base);
  }
}

export async function startAudioRecorderWorklet(audioRecorderHandler, deviceId) {
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

  const micStream = await getMicStream(deviceId);
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
