/**
 * The relay protocol, ported from the WebSocket half of `app/static/js/app.js`.
 *
 * One `LiveSession` is one browser-facing WebSocket to `/ws/{user}/{session}`.
 * The relay keeps a succession of Gemini Live sessions behind it and never
 * closes this socket for its own reasons, so a close here means the network or
 * the server went away and reconnecting is always the right response.
 *
 * The relay's frames are audio-in / JSON-out: binary frames upstream carry
 * 16 kHz mono PCM16, and every downstream frame is a JSON envelope.
 */

const RECONNECT_MS = 3000;

export function base64ToArray(base64) {
  let standard = base64.replace(/-/g, "+").replace(/_/g, "/");
  while (standard.length % 4) standard += "=";
  const binary = atob(standard);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class LiveSession {
  /**
   * @param {object} opts
   * @param {() => string} opts.url        built fresh per attempt, so a
   *   reconnect picks up a new session id rather than resuming a dead one
   * @param {() => object} opts.setup      the first message: {glossary, voice}
   * @param {(ev: object) => void} opts.onEvent
   * @param {(state: string, detail?: string) => void} opts.onStatus
   */
  constructor({ url, setup, onEvent, onStatus }) {
    this._url = url;
    this._setup = setup;
    this._onEvent = onEvent || (() => {});
    this._onStatus = onStatus || (() => {});
    this._ws = null;
    this._retry = null;
    this._closed = false;
  }

  connect() {
    this._closed = false;
    this._open();
  }

  _open() {
    let url;
    try {
      url = this._url();
    } catch (err) {
      this._onStatus("error", String(err));
      return;
    }
    this._onStatus("connecting");
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this._ws = ws;

    ws.onopen = () => {
      // The relay waits up to SETUP_TIMEOUT_SEC for this and falls back to its
      // own on-disk glossary if it never arrives, so a late send is not fatal
      // — but it would silently drop the user's own terms.
      ws.send(JSON.stringify(this._setup()));
      this._onStatus("connected");
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this._dispatch(msg);
    };

    ws.onerror = () => this._onStatus("error");

    ws.onclose = () => {
      this._ws = null;
      if (this._closed) return;
      this._onStatus("disconnected");
      this._retry = setTimeout(() => this._open(), RECONNECT_MS);
    };
  }

  _dispatch(msg) {
    if (msg.turnComplete === true) {
      this._onEvent({ type: "turnComplete" });
      return;
    }
    if (msg.inputTranscription && msg.inputTranscription.text) {
      this._onEvent({
        type: "input",
        text: msg.inputTranscription.text,
        finished: !!msg.inputTranscription.finished,
      });
    }
    if (msg.outputTranscription && msg.outputTranscription.text) {
      this._onEvent({
        type: "output",
        text: msg.outputTranscription.text,
        finished: !!msg.outputTranscription.finished,
      });
    }
    for (const part of (msg.content && msg.content.parts) || []) {
      const inline = part.inlineData;
      if (inline && (inline.mimeType || "").startsWith("audio/pcm")) {
        this._onEvent({ type: "audio", buffer: base64ToArray(inline.data) });
      }
    }
  }

  /** True once the socket is up; callers drop mic frames until then. */
  get ready() {
    return !!this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  send(pcmBuffer) {
    if (this.ready) this._ws.send(pcmBuffer);
  }

  close() {
    this._closed = true;
    clearTimeout(this._retry);
    this._retry = null;
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.close();
      this._ws = null;
    }
    this._onStatus("closed");
  }
}
