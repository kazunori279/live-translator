"""FastAPI application for an AI panel assistant built on the Gemini Live API.

The assistant sits in on a live panel discussion, hears everything, and speaks
only when a panellist addresses it by name. Silence is enforced twice: the system
instruction asks for it, and `OutputGate` below drops any audio the model
produces for a turn nobody addressed. The prompt is the polite request; the gate
is the guarantee.
"""

import asyncio
import base64
import json
import logging
import os
import sys
import unicodedata
import warnings
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# Load environment variables from .env file BEFORE constructing the genai client.
load_dotenv(Path(__file__).parent / ".env")

# Ensure non-Vertex AI mode for Gemini API key auth.
# These env vars cause the SDK to route through aiplatform.googleapis.com.
os.environ.pop("GOOGLE_GENAI_USE_VERTEXAI", None)
os.environ.pop("GOOGLE_CLOUD_PROJECT", None)
os.environ.pop("GOOGLE_CLOUD_LOCATION", None)

from google import genai  # noqa: E402
from google.genai import types  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))
from panel_agent import (  # noqa: E402
    ASSISTANT_NAME,
    ASSISTANT_NAME_JA,
    DEFAULT_VOICE,
    DISCUSSION_TOPIC,
    MODEL,
    TOPIC_SUGGESTION_PROMPT,
    VOICES,
    WakeMatcher,
    build_briefing,
    build_panel_instruction,
    knowledge_files,
    load_default_glossary,
    resolve_voice,
)

MAX_GLOSSARY_ENTRIES = 1000  # safety cap on per-session glossary length
SETUP_TIMEOUT_SEC = 5  # how long to wait for the client's setup message
CONNECT_TIMEOUT_SEC = 10
RETRY_BACKOFF_INIT = 0.2
RETRY_BACKOFF_MAX = 4.0
# How long a session draining after GoAway may stay silent before we cut over
# to its replacement. Long enough that a turn still in flight is never clipped
# (partial transcriptions and audio chunks both keep the timer alive), short
# enough that a session which has stopped talking altogether is not left to
# swallow the full GoAway deadline.
GOAWAY_IDLE_GRACE_SEC = 5.0
# Once a draining session has been quiet this long, the replacement starts
# hearing the microphone as well, so speech going into a session that has
# stopped answering still reaches one that hasn't. Mirroring from the stall
# rather than from the GoAway itself keeps a session that is merely between
# chunks from having the same question answered twice, once by each; the audio
# it missed is replayed on attach, so waiting costs no coverage, only realtime
# warm-up for the replacement.
DRAIN_MIRROR_QUIET_SEC = 3.0
# Mic frames kept for replay into a replacement session. ~125 frames/sec of
# 512 bytes, so this is ~10s and ~320KB; what actually gets replayed is only
# the audio the outgoing session never answered, which is bounded by
# GOAWAY_IDLE_GRACE_SEC and so always well inside the window.
RECENT_AUDIO_MAX_FRAMES = 1250
AUTHOR = "panel_assistant"  # constant author tag echoed in every server frame

# --- Output gate tuning ------------------------------------------------------
# Audio the gate will hold for a turn that has not been armed yet. Output can
# start before the input transcription that arms the turn has finished arriving,
# so held output is flushed rather than dropped if the arm lands late. At 24 kHz
# 16-bit mono this is about four seconds — far more than the gap between speech
# ending and its transcription completing. A turn that overruns it is one the
# model started answering unprompted, which is exactly what should be discarded.
GATE_BUFFER_MAX_BYTES = 200_000
# How long a manual arm (the "Ask Gemini" button) stays open waiting for the
# question to be asked. Long enough for the moderator to press, draw breath and
# speak; short enough that a stray press does not leave the gate open all night.
MANUAL_ARM_TTL_SEC = 30.0
# Input transcript kept for wake-phrase matching. The phrase arrives in
# fragments and can straddle a turn boundary, so matching runs against a rolling
# window rather than a single fragment.
WAKE_WINDOW_CHARS = 400


def _build_display_map(
    entries: list[tuple[str, str, str]],
) -> list[tuple[str, str]]:
    """Build (nfkc_target, transcription) pairs for server-side transcript replacement."""
    pairs = [
        (unicodedata.normalize("NFKC", tgt), disp)
        for src, tgt, disp in entries
        if tgt != disp
    ]
    pairs.sort(key=lambda x: len(x[0]), reverse=True)
    return pairs


def _apply_display_map(text: str, display_map: list[tuple[str, str]]) -> str:
    """Replace glossary target strings in *text* with their display transcription."""
    if not text or not display_map:
        return text
    out = unicodedata.normalize("NFKC", text)
    for nfkc_target, transcription in display_map:
        if nfkc_target in out:
            out = out.replace(nfkc_target, transcription)
    return out


class _TranscriptRewriter:
    """Applies the display map across streaming fragment boundaries.

    Gemini sends the transcript in small increments and the browser appends
    them, so replacing inside a single increment misses any term that straddles
    a boundary. Measured: クバネティス arrives as 'をク' + 'バネティ' + 'スに', and no
    fragment on its own contains the term, so the replacement never fires. Those
    turns carry no `finished` message either, so there is no complete sentence to
    fall back on.

    The protocol is append-only, so this holds back any trailing text that could
    still grow into a glossary term and emits everything ahead of it. The held
    text is shorter than the longest target, and the next fragment releases it.
    `turnComplete` flushes whatever is still held.
    """

    def __init__(self, display_map: list[tuple[str, str]]):
        self._map = display_map
        self._pending = ""
        self._prefixes = {
            target[:i] for target, _ in display_map for i in range(1, len(target))
        }
        self._max_hold = max((len(t) for t, _ in display_map), default=1) - 1

    def _hold_len(self, text: str) -> int:
        """Length of the longest suffix that is still a partial glossary term."""
        for n in range(min(self._max_hold, len(text)), 0, -1):
            if text[-n:] in self._prefixes:
                return n
        return 0

    def feed(self, text: str) -> str:
        """Take a streamed increment, return the part safe to send now."""
        if not self._map:
            return text
        buf = _apply_display_map(self._pending + text, self._map)
        hold = self._hold_len(buf)
        cut = len(buf) - hold
        self._pending = buf[cut:]
        return buf[:cut]

    def supersede(self, text: str) -> str:
        """A `finished` transcript carries the whole sentence, so it replaces."""
        self._pending = ""
        return _apply_display_map(text, self._map)

    def flush(self) -> str:
        """Release any held tail — the turn is over, nothing more is coming."""
        out, self._pending = self._pending, ""
        return out


class OutputGate:
    """Decides, per turn, whether the assistant is allowed to be heard.

    The Live API has no "respond only when addressed" switch — `proactive_audio`
    is not supported on this model — so the model answers everything it hears and
    the relay throws away what nobody asked for. Everything the panel says
    reaches the model, which is the point: it needs the whole discussion in
    context to answer well when it finally is asked something.

    A turn is armed by a wake phrase in the input transcription ("Hey Gemini,
    ...") or explicitly by the moderator's UI. Model output for an unarmed turn
    is buffered, not dropped outright, because the model can start speaking
    before the transcription that arms the turn has finished arriving. If the arm
    lands, the buffer flushes and the answer plays whole; if the turn completes
    unarmed, the buffer is discarded and the room hears nothing.
    """

    def __init__(self, matcher: WakeMatcher, now):
        self._matcher = matcher
        self._now = now  # loop.time, injected so tests can drive it
        self._turn_text = ""  # what the panel has said in this turn
        self._heard = ""  # rolling window, spanning turn boundaries
        self._armed = False
        self._reason = ""
        self._buffer: list[dict] = []
        self._buffered_bytes = 0
        self._overflowed = False
        self._spoke = False  # this turn produced audible output
        self._manual_until = 0.0
        # Counters for the soak harness and the status line.
        self.answered_turns = 0
        self.suppressed_turns = 0

    # -- state ---------------------------------------------------------------

    @property
    def armed(self) -> bool:
        return self._armed or self._now() < self._manual_until

    @property
    def reason(self) -> str:
        # Derived rather than stored: a manual arm can expire on its own, and a
        # stale reason on the status pill would claim the gate is open when it
        # has already closed.
        return self._reason if self.armed else ""

    def arm(self, reason: str) -> None:
        """Open the gate for this turn (wake phrase, or the moderator's button)."""
        self._armed = True
        self._reason = reason

    def arm_manual(self, reason: str = "button") -> None:
        """Open the gate now and keep it open until the question actually lands.

        The moderator presses the button and *then* speaks, so a manual arm has
        to survive the turn boundary between the press and the question.
        """
        self._manual_until = self._now() + MANUAL_ARM_TTL_SEC
        self._reason = reason

    def disarm(self) -> None:
        self._armed = False
        self._manual_until = 0.0
        self._reason = ""

    # -- input side ----------------------------------------------------------

    def hear(self, text: str) -> str | None:
        """Feed panel speech in. Returns the wake pattern that fired, if any.

        Matching runs against two strings, and needs both. The turn's own text
        gives the patterns anchored to the start of an utterance a clean anchor:
        "Gemini, why is that?" is an address, but only if "Gemini" really is the
        first word — and the rolling window would have the tail of the previous
        speaker's sentence sitting in front of it. The rolling window in turn
        catches a phrase the voice-activity detector split down the middle,
        leaving "Hey Gemini" in one turn and the question in the next.
        """
        if not text:
            return None
        self._turn_text += text
        self._heard = (self._heard + text)[-WAKE_WINDOW_CHARS:]
        if self._armed:
            return None
        fired = self._matcher.match(self._turn_text) or self._matcher.match(
            self._heard
        )
        if fired:
            # Clear both so the same phrase cannot arm a second turn.
            self._turn_text = ""
            self._heard = ""
            self.arm("wake")
        return fired

    # -- output side ---------------------------------------------------------

    def filter(self, envelope: dict) -> list[dict]:
        """Return the envelopes to forward now, given the gate's state.

        The discussion transcript and the turn boundary always pass: they make
        no sound, they drive the captions, and the client needs the boundary to
        close the turn out even when the reply that came with it is discarded.
        """
        speech = _has_model_output(envelope)
        if not speech:
            return [envelope]
        if self.armed:
            self._spoke = True
            if self._buffer:
                held, self._buffer = self._buffer, []
                self._buffered_bytes = 0
                return held + [envelope]
            return [envelope]
        # Unarmed, so the reply is held — but the same message can carry the
        # panel's own transcript and the end of the turn, and both of those are
        # silent. Split them off and send them now: the buffer is about to be
        # discarded, and the client needs the boundary to close out the turn.
        passthrough = {k: envelope.pop(k) for k in _SILENT_KEYS if k in envelope}
        silent = [passthrough] if passthrough else []
        if self._overflowed:
            return silent
        self._buffered_bytes += _audio_bytes(envelope)
        if self._buffered_bytes > GATE_BUFFER_MAX_BYTES:
            # Seconds of unrequested speech with no arm in sight. This is the
            # model answering something nobody asked it, so stop paying to hold
            # it and stay silent for the rest of the turn.
            self._overflowed = True
            self._buffer = []
            self._buffered_bytes = 0
            logger.debug("Gate: buffer overflowed, suppressing rest of turn")
            return silent
        self._buffer.append(envelope)
        return silent

    def end_turn(self) -> bool:
        """Close the turn. Returns True if output was suppressed."""
        suppressed = bool(self._buffer) or self._overflowed
        if suppressed:
            logger.info(
                "Gate: suppressed an unrequested reply (%d buffered frames%s)",
                len(self._buffer),
                ", overflowed" if self._overflowed else "",
            )
            self.suppressed_turns += 1
        if self._spoke:
            self.answered_turns += 1
            # The question has been answered, so a manual arm has done its job.
            self._manual_until = 0.0
        self._armed = False
        # Keep only the tail of the heard window. A wake phrase can straddle a
        # turn boundary when the voice-activity detector splits "Hey Gemini"
        # from the question that follows it, so some carry-over is needed — but
        # carrying a whole turn lets the end of one sentence sit next to the
        # start of the next and form a phrase neither speaker said.
        self._heard = self._heard[-60:]
        self._turn_text = ""
        self._buffer = []
        self._buffered_bytes = 0
        self._overflowed = False
        self._spoke = False
        return suppressed

    def drop_pending(self) -> None:
        """Throw away held output — the session it belonged to is gone."""
        self._buffer = []
        self._buffered_bytes = 0
        self._overflowed = False
        self._spoke = False
        self._armed = False


def _has_model_output(envelope: dict) -> bool:
    """Whether this envelope carries something the room would see or hear."""
    return bool(envelope.get("content") or envelope.get("outputTranscription"))


# Keys that can share an envelope with the model's reply but belong to the
# panel, not the assistant. Held-back speech must never take these with it.
_SILENT_KEYS = ("inputTranscription", "turnComplete")


def _audio_bytes(envelope: dict) -> int:
    content = envelope.get("content") or {}
    total = 0
    for part in content.get("parts") or []:
        data = (part.get("inlineData") or {}).get("data")
        if data:
            total += len(data)
    return total


# DEBUG locally, where the verbose SDK and websockets output is what you want
# while working on the relay. Deployments set LOG_LEVEL=INFO: at DEBUG the
# websockets client logs the full Live API handshake, including the
# `x-goog-api-key` header, which on Cloud Run lands in Cloud Logging.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "DEBUG").upper(),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Suppress Pydantic serialization warnings emitted by the genai SDK.
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

app = FastAPI()

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")

client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])

# The briefing is read from disk once at import. It is static content baked into
# the image, and rebuilding it per session would re-read ten files on every
# GoAway reconnect for a result that cannot have changed.
BRIEFING = build_briefing()
logger.info(
    "Knowledge base: %d files, %d-char briefing",
    len(knowledge_files()),
    len(BRIEFING),
)


@app.get("/")
async def root():
    """Serve the index.html page."""
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.get("/caption")
async def caption():
    """Serve the caption overlay page (window mirror + subtitles)."""
    return FileResponse(Path(__file__).parent / "static" / "caption.html")


@app.get("/api/config")
async def get_config():
    """Panel and voice configuration for the client UI."""
    return {
        "model": MODEL,
        "voices": VOICES,
        "defaultVoice": DEFAULT_VOICE,
        "assistantName": ASSISTANT_NAME,
        "assistantNameJa": ASSISTANT_NAME_JA,
        "topic": DISCUSSION_TOPIC,
        "knowledge": [p.name for p in knowledge_files()],
        "briefingChars": len(BRIEFING),
    }


@app.get("/api/glossary/defaults")
async def get_default_glossary():
    """Return the seed glossary baked into the image (used when localStorage is empty)."""
    entries = load_default_glossary()
    return {
        "pairs": [
            {"source": s, "target": t, "transcription": d} for s, t, d in entries
        ]
    }


@dataclass
class SetupData:
    glossary: list[tuple[str, str, str]] = field(default_factory=list)
    voice: str = DEFAULT_VOICE


def _parse_setup(raw: str) -> SetupData:
    """Parse the client's setup message into glossary + output voice."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return SetupData()
    entries: list[tuple[str, str, str]] = []
    for entry in (data.get("glossary") or [])[:MAX_GLOSSARY_ENTRIES]:
        if not isinstance(entry, dict):
            continue
        src = (entry.get("source") or "").strip()
        tgt = (entry.get("target") or "").strip()
        if not src or not tgt:
            continue
        disp_raw = entry.get("transcription")
        disp = disp_raw.strip() if isinstance(disp_raw, str) and disp_raw.strip() else tgt
        entries.append((src, tgt, disp))

    # Anything unrecognised falls back to the default: an unknown voice name is a
    # hard connect-time failure upstream ("No matching speaker voice found"),
    # which session_loop would retry forever.
    raw_voice = data.get("voice")
    voice = resolve_voice(raw_voice if isinstance(raw_voice, str) else None)

    return SetupData(glossary=entries, voice=voice)


def _grounding_json(gm: types.GroundingMetadata) -> dict | None:
    """The parts of grounding metadata the client has to display.

    Google's Grounding with Search terms require that when a response is
    grounded, the Search Suggestions chip is rendered as delivered and the
    sources are attributed. Both travel here; `caption.html` and `app.js` render
    them.
    """
    out: dict = {}
    chunks = []
    for chunk in gm.grounding_chunks or []:
        web = getattr(chunk, "web", None)
        if web is None:
            continue
        chunks.append(
            {
                "uri": web.uri or "",
                "title": web.title or "",
                "domain": getattr(web, "domain", "") or "",
            }
        )
    if chunks:
        out["chunks"] = chunks
    if gm.web_search_queries:
        out["queries"] = list(gm.web_search_queries)
    sep = gm.search_entry_point
    if sep is not None and sep.rendered_content:
        out["searchEntryPoint"] = sep.rendered_content
    return out or None


def _envelope_from(msg: types.LiveServerMessage) -> dict | None:
    """Translate a LiveServerMessage into the camelCase JSON shape `app.js` expects.

    Returns None for messages the client doesn't care about (setup acks, go_away,
    session-resumption updates) so the caller can skip them.
    """
    out: dict = {}

    sc = msg.server_content
    if sc:
        if sc.turn_complete:
            out["turnComplete"] = True
        if sc.input_transcription:
            out["inputTranscription"] = {
                "text": sc.input_transcription.text or "",
                "finished": bool(sc.input_transcription.finished),
            }
        if sc.output_transcription:
            out["outputTranscription"] = {
                "text": sc.output_transcription.text or "",
                "finished": bool(sc.output_transcription.finished),
            }
        if sc.grounding_metadata:
            grounding = _grounding_json(sc.grounding_metadata)
            if grounding:
                out["groundingMetadata"] = grounding
        if sc.model_turn and sc.model_turn.parts:
            parts = []
            for p in sc.model_turn.parts:
                pj: dict = {}
                if p.text is not None:
                    pj["text"] = p.text
                if p.thought:
                    pj["thought"] = True
                if p.inline_data and p.inline_data.data is not None:
                    pj["inlineData"] = {
                        "mimeType": p.inline_data.mime_type or "",
                        "data": base64.b64encode(p.inline_data.data).decode("ascii"),
                    }
                if pj:
                    parts.append(pj)
            if parts:
                out["content"] = {"role": "model", "parts": parts}
                # Streaming chunks are partial; the final frame carries turn_complete.
                if not sc.turn_complete:
                    out["partial"] = True

    if msg.usage_metadata:
        out["usageMetadata"] = msg.usage_metadata.model_dump(
            by_alias=True, exclude_none=True, mode="json"
        )

    if not out:
        return None
    out["author"] = AUTHOR
    return out


@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    session_id: str,
) -> None:
    """WebSocket endpoint bridging panel audio to a gated Gemini Live session."""
    logger.info("WS request: user=%s session=%s", user_id, session_id)
    await websocket.accept()

    # Wait for the client's setup message (carries the per-session glossary).
    # Falls back to the on-disk default glossary if the client doesn't send one
    # within SETUP_TIMEOUT_SEC (older clients, network hiccups).
    setup_data: SetupData | None = None
    try:
        setup_raw = await asyncio.wait_for(
            websocket.receive_text(), timeout=SETUP_TIMEOUT_SEC
        )
        setup_data = _parse_setup(setup_raw)
        logger.debug(
            "Setup received: %d glossary entries, voice=%s",
            len(setup_data.glossary), setup_data.voice,
        )
    except asyncio.TimeoutError:
        logger.warning(
            "No setup message within %ds; using default glossary.", SETUP_TIMEOUT_SEC
        )
    except WebSocketDisconnect:
        logger.debug("Client disconnected before sending setup")
        return

    glossary_entries = setup_data.glossary if setup_data else None
    voice = setup_data.voice if setup_data else DEFAULT_VOICE

    display_map = _build_display_map(
        glossary_entries if glossary_entries is not None else load_default_glossary()
    )
    rewriter = _TranscriptRewriter(display_map)
    system_instruction = build_panel_instruction(
        glossary_entries=glossary_entries, briefing=BRIEFING
    )
    gate = OutputGate(WakeMatcher(), asyncio.get_running_loop().time)
    logger.info(
        "Panel assistant ready: voice=%s, instruction=%d chars",
        voice, len(system_instruction),
    )

    async def _notify(payload: dict) -> None:
        """Send a control frame to the browser, ignoring a dead socket."""
        try:
            await websocket.send_text(json.dumps({**payload, "author": AUTHOR}))
        except Exception:  # noqa: BLE001
            pass

    # Gate state is re-evaluated at every turn boundary, which during a live
    # discussion is every few seconds. Only transitions are worth a frame.
    last_gate_sent: tuple[bool, str] | None = None

    async def _notify_gate() -> None:
        nonlocal last_gate_sent
        state = (gate.armed, gate.reason)
        if state == last_gate_sent:
            return
        last_gate_sent = state
        await _notify({"gate": {"armed": state[0], "reason": state[1]}})

    # Shared state between the upstream forwarder and the session loop. The
    # forwarder has the lifetime of the browser WebSocket and writes to whichever
    # Live session is currently open; the session loop tears down old sessions
    # and opens fresh ones as the Live API expires them, without ever closing
    # the browser-facing WS. Sessions carry no resumption handle, so each one
    # starts with an empty history.
    current_session: types.AsyncSession | None = None
    # While a session drains after GoAway its replacement is already open but
    # idle; once the drain is judged stalled the replacement is fed the
    # microphone too, and mirror_session is what it is fed through.
    mirror_session: types.AsyncSession | None = None
    # Every mic frame with the time it arrived, so a replacement session can be
    # given the audio the session it replaces never answered. Bounded by frame
    # count rather than trimmed by age: the cost is a fixed ~320KB per
    # connection and no per-frame housekeeping on the hot path.
    recent_audio: deque[tuple[float, bytes]] = deque(maxlen=RECENT_AUDIO_MAX_FRAMES)

    def _audio_since(t: float) -> bytes:
        """Mic audio captured from *t* onwards, as one blob."""
        return b"".join(frame for ts, frame in recent_audio if ts >= t)

    async def _send_audio(sess: "types.AsyncSession", audio: bytes) -> None:
        try:
            await sess.send_realtime_input(
                audio=types.Blob(mime_type="audio/pcm;rate=16000", data=audio)
            )
        except Exception:  # noqa: BLE001
            pass

    async def _send_text(sess: "types.AsyncSession", text: str) -> None:
        """Inject a text turn mid-conversation.

        `send_realtime_input(text=...)` and not `send_client_content`: on this
        model the latter is for seeding history before the stream starts and does
        not prompt a reply once audio is flowing.
        """
        try:
            await sess.send_realtime_input(text=text)
        except Exception:  # noqa: BLE001
            logger.warning("Failed to inject text turn", exc_info=True)

    async def _handle_control(raw: str) -> None:
        """Act on a control message from the moderator's UI."""
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            logger.debug("Ignoring non-JSON text frame")
            return
        kind = msg.get("type")
        sess = current_session

        if kind == "arm":
            # The moderator is about to ask out loud, without a wake phrase.
            gate.arm_manual("button")
            await _notify_gate()
        elif kind == "disarm":
            gate.disarm()
            await _notify_gate()
        elif kind == "topic":
            gate.arm_manual("topic")
            await _notify_gate()
            if sess is not None:
                await _send_text(sess, TOPIC_SUGGESTION_PROMPT)
        elif kind == "ask":
            text = (msg.get("text") or "").strip()
            if not text:
                return
            gate.arm_manual("typed")
            await _notify_gate()
            if sess is not None:
                await _send_text(
                    sess,
                    f"[A panellist is asking you directly, in text: {text}]",
                )
        else:
            logger.debug("Unknown control message: %r", kind)

    async def upstream_task() -> None:
        """Forward panel audio into whichever Live session is current."""
        loop = asyncio.get_running_loop()
        try:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    logger.debug("Upstream: client disconnected")
                    return
                if "bytes" in message:
                    audio = message["bytes"]
                    recent_audio.append((loop.time(), audio))
                    mirror = mirror_session
                    if mirror is not None:
                        await _send_audio(mirror, audio)
                    sess = current_session
                    if sess is None:
                        continue
                    await _send_audio(sess, audio)
                elif "text" in message:
                    await _handle_control(message["text"])
        except WebSocketDisconnect:
            logger.debug("Upstream: client disconnected")

    async def session_loop() -> None:
        """Open Gemini Live sessions in succession, replacing on GoAway."""
        nonlocal current_session, mirror_session

        def _build_config():
            cfg = types.LiveConnectConfig(
                response_modalities=[types.Modality.AUDIO],
                input_audio_transcription=types.AudioTranscriptionConfig(),
                output_audio_transcription=types.AudioTranscriptionConfig(),
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(
                            voice_name=voice
                        )
                    )
                ),
                system_instruction=types.Content(
                    parts=[types.Part(text=system_instruction)]
                ),
                # The briefing is a snapshot; anything newer than it, or any
                # figure the model is unsure of, comes from Search. Grounding
                # metadata comes back on server_content and is forwarded to the
                # client, which is what makes the required source attribution
                # possible.
                tools=[types.Tool(google_search=types.GoogleSearch())],
            )
            logger.debug(
                "LiveConnectConfig: model=%s voice=%s tools=google_search",
                MODEL, voice,
            )
            return cfg

        next_ready = asyncio.Event()
        next_session_ref: list = [None]
        next_conn_ref: list = [None]
        # next_ready is set by _open_next() alone, which only runs on the GoAway
        # path. Waiting on it when no open is in flight — after a session error,
        # say — parks the loop forever, so gate the wait on this instead.
        open_pending = False
        # Audio a cut-over session never answered, waiting to be replayed into
        # whichever session is adopted next.
        pending_preroll = b""

        async def _open_next():
            """Open and store the next session (runs concurrently with drain)."""
            try:
                cfg = _build_config()
                conn = client.aio.live.connect(model=MODEL, config=cfg)
                sess = await conn.__aenter__()
                next_session_ref[0] = sess
                next_conn_ref[0] = conn
                logger.debug("Next session ready")
            except Exception:  # noqa: BLE001
                logger.warning("Failed to open next session", exc_info=True)
            next_ready.set()

        def _cleanup_next():
            next_ready.clear()
            if next_conn_ref[0] is not None:
                conn = next_conn_ref[0]
                next_conn_ref[0] = None
                next_session_ref[0] = None
                asyncio.create_task(conn.__aexit__(None, None, None))

        retry_backoff = RETRY_BACKOFF_INIT
        while True:
            conn = None
            open_next_task = None
            error_cleanup = False
            try:
                if open_pending:
                    await next_ready.wait()
                    next_ready.clear()
                    open_pending = False

                if next_session_ref[0] is not None:
                    session = next_session_ref[0]
                    conn = next_conn_ref[0]
                    next_session_ref[0] = None
                    next_conn_ref[0] = None
                    # It has been fed as the mirror; from here it is fed as the
                    # current session. Dropping the mirror in the same step —
                    # no await in between — keeps mic frames from going twice.
                    mirror_session = None
                    logger.debug("Using pre-opened session")
                else:
                    cfg = _build_config()
                    conn = client.aio.live.connect(model=MODEL, config=cfg)
                    session = await asyncio.wait_for(
                        conn.__aenter__(), timeout=CONNECT_TIMEOUT_SEC
                    )
                    logger.debug("Opened fresh Live session")

                if pending_preroll:
                    # Said into a session that was cut over before it could
                    # answer. Replayed before current_session is assigned, so
                    # it cannot interleave with the live frames the forwarder
                    # is about to start sending here.
                    logger.debug(
                        "Replaying %d unanswered bytes into replacement",
                        len(pending_preroll),
                    )
                    await _send_audio(session, pending_preroll)
                    pending_preroll = b""

                current_session = session
                retry_backoff = RETRY_BACKOFF_INIT

                go_away_event = asyncio.Event()
                go_away_secs: float = 30
                loop = asyncio.get_running_loop()
                last_relay_at = loop.time()
                # Whether the session signed off properly or the stream just
                # stopped. Only the former means it answered what it heard.
                answered_out = False

                async def _relay_session() -> None:
                    """Forward Gemini messages to the browser until session ends."""
                    nonlocal last_relay_at, answered_out
                    while True:
                        saw_message = False
                        async for msg in session.receive():
                            saw_message = True
                            if msg.go_away is not None:
                                tl = msg.go_away.time_left or "30s"
                                nonlocal go_away_secs
                                go_away_secs = (
                                    int(tl.rstrip("s"))
                                    if tl.endswith("s")
                                    else 30
                                )
                                logger.info(
                                    "GoAway received (time_left=%s); "
                                    "opening next session",
                                    msg.go_away.time_left,
                                )
                                go_away_event.set()
                                continue
                            envelope = _envelope_from(msg)
                            if envelope is None:
                                continue

                            # Wake detection runs before the output filter, so a
                            # phrase transcribed in the same batch as the first
                            # audio chunk still arms that chunk's turn.
                            it = envelope.get("inputTranscription")
                            if it and it.get("text"):
                                fired = gate.hear(it["text"])
                                if fired:
                                    logger.info(
                                        "Wake phrase detected (%s)", fired
                                    )
                                    await _notify_gate()

                            ot = envelope.get("outputTranscription")
                            if ot and ot.get("text") and display_map:
                                original = ot["text"]
                                if ot.get("finished"):
                                    ot["text"] = rewriter.supersede(original)
                                else:
                                    ot["text"] = rewriter.feed(original)
                                if ot["text"] != original:
                                    logger.debug(
                                        "Display map: %r -> %r",
                                        original,
                                        ot["text"],
                                    )
                            if envelope.get("turnComplete") and display_map:
                                # Nothing more is coming for this turn, so any
                                # tail held back mid-term has to go out now
                                # rather than wait for the next turn's stream.
                                tail = rewriter.flush()
                                if tail:
                                    ot = envelope.setdefault(
                                        "outputTranscription",
                                        {"text": "", "finished": False},
                                    )
                                    ot["text"] = (ot.get("text") or "") + tail

                            # The gate can move the turn boundary into a
                            # separate envelope, so read it before filtering.
                            ended = bool(envelope.get("turnComplete"))
                            for out in gate.filter(envelope):
                                await websocket.send_text(json.dumps(out))
                            last_relay_at = loop.time()

                            if ended:
                                if gate.end_turn():
                                    await _notify({"suppressed": True})
                                await _notify_gate()

                            if go_away_event.is_set():
                                sc = msg.server_content
                                if sc and sc.turn_complete:
                                    logger.debug(
                                        "Turn complete after GoAway; "
                                        "reopening"
                                    )
                                    answered_out = True
                                    return
                        if not saw_message:
                            return

                async def _drain_silent() -> None:
                    """Resolve once the browser has heard nothing for a while."""
                    while True:
                        quiet = loop.time() - last_relay_at
                        if quiet >= GOAWAY_IDLE_GRACE_SEC:
                            return
                        await asyncio.sleep(GOAWAY_IDLE_GRACE_SEC - quiet)

                async def _mirror_when_stalled() -> None:
                    """Tee the microphone into the replacement once the drain stalls.

                    The dying session has answered nothing since
                    *last_relay_at*, so everything captured from that point on
                    is replayed into the replacement first — it hears the whole
                    sentence, not just the tail that happened to fall after the
                    stall was declared.
                    """
                    nonlocal mirror_session
                    while True:
                        quiet = loop.time() - last_relay_at
                        if quiet >= DRAIN_MIRROR_QUIET_SEC:
                            break
                        await asyncio.sleep(DRAIN_MIRROR_QUIET_SEC - quiet)
                    await next_ready.wait()
                    sess = next_session_ref[0]
                    if sess is None:  # the replacement failed to open
                        return
                    # Catch up in whole blobs, re-checking after each send for
                    # frames that landed while it was in flight. The live tee
                    # only starts once nothing is left, and the last check and
                    # the assignment have no await between them, so the
                    # replacement can neither miss a frame nor hear the replay
                    # out of order.
                    cut = last_relay_at
                    replayed = 0
                    while True:
                        pending = [(ts, f) for ts, f in recent_audio if ts >= cut]
                        if not pending:
                            break
                        cut = pending[-1][0] + 1e-6
                        blob = b"".join(f for _, f in pending)
                        replayed += len(blob)
                        await _send_audio(sess, blob)
                    mirror_session = sess
                    logger.debug(
                        "Mirroring mic into replacement (%d bytes replayed)", replayed
                    )

                relay_task = asyncio.create_task(_relay_session())
                go_away_wait = asyncio.create_task(go_away_event.wait())
                done, _ = await asyncio.wait(
                    {relay_task, go_away_wait},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if go_away_wait in done and relay_task not in done:
                    # Clear before the open, not after the wait: a previous
                    # attempt that was abandoned mid-flight can leave the event
                    # set, and starting from that would let the loop sail past
                    # the wait and open a duplicate session.
                    next_ready.clear()
                    open_next_task = asyncio.create_task(_open_next())
                    open_pending = True
                    # Stay on the dying session only while it is still speaking.
                    # Waiting out the whole GoAway deadline for a turn that never
                    # completes is dead air the client hears in full, so a drain
                    # that falls silent is cut over instead.
                    silent_task = asyncio.create_task(_drain_silent())
                    mirror_task = asyncio.create_task(_mirror_when_stalled())
                    try:
                        drained, _ = await asyncio.wait(
                            {relay_task, silent_task},
                            timeout=go_away_secs,
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                    finally:
                        silent_task.cancel()
                        # No new mirror may attach now, but one already feeding
                        # the replacement keeps doing so through the swap, so
                        # the handover itself costs no audio at all.
                        mirror_task.cancel()
                    if relay_task in drained:
                        # The drain may have ended by failing. A replacement is
                        # already on its way so there is nothing to retry, but
                        # the exception still has to be retrieved or asyncio
                        # reports it as unhandled.
                        drain_exc = relay_task.exception()
                        if drain_exc is not None:
                            logger.debug("Draining session failed: %r", drain_exc)
                        if answered_out and mirror_session is not None:
                            # A drain that stalled long enough to be mirrored
                            # and then completed its turn has answered the very
                            # audio the replacement was fed, so the replacement
                            # would answer it all over again. Throwing the
                            # session away costs one fresh connect; sorting its
                            # queued output apart from the next real turn costs
                            # more.
                            logger.debug(
                                "Discarding mirrored replacement (drain recovered)"
                            )
                            mirror_session = None
                            _cleanup_next()
                            open_pending = False
                    else:
                        logger.debug(
                            "Drain %s; reopening",
                            "went silent"
                            if silent_task in drained
                            else "hit the GoAway deadline",
                        )
                        relay_task.cancel()
                        try:
                            await relay_task
                        except asyncio.CancelledError:
                            pass
                        # Held output belonged to a turn on a session that is
                        # about to be closed. It can never be completed, so it
                        # can never be legitimately released.
                        gate.drop_pending()
                        if mirror_session is None:
                            # Cut over before the mirror could attach — the
                            # GoAway can land while a panellist is mid-sentence
                            # and the session, quiet for a while already, gets
                            # dropped a few milliseconds later. Nothing was
                            # relayed after last_relay_at, so audio from that
                            # point on went unanswered and is owed to the
                            # replacement; anything earlier was answered and
                            # replaying it would answer it twice.
                            pending_preroll = _audio_since(last_relay_at)
                        # The abandoned turn will never report itself complete,
                        # and the client keeps appending to an open caption
                        # until something does. Close it before the next
                        # session starts a turn of its own.
                        await _notify({"turnComplete": True})
                else:
                    go_away_wait.cancel()
                    if relay_task.done() and relay_task.exception():
                        raise relay_task.exception()
                logger.debug("Live session ended; reopening")
            except WebSocketDisconnect:
                error_cleanup = True
                raise
            except Exception:  # noqa: BLE001
                error_cleanup = True
                logger.warning(
                    "Session error; retrying in %.1fs", retry_backoff,
                    exc_info=True,
                )
                await asyncio.sleep(retry_backoff)
                retry_backoff = min(retry_backoff * 2, RETRY_BACKOFF_MAX)
            finally:
                current_session = None
                if conn is not None:
                    try:
                        await conn.__aexit__(None, None, None)
                    except Exception:  # noqa: BLE001
                        pass
                if error_cleanup:
                    gate.drop_pending()
                    if open_next_task and not open_next_task.done():
                        open_next_task.cancel()
                    # The replacement is about to be closed, so stop feeding it.
                    mirror_session = None
                    _cleanup_next()
                    # Nothing will set next_ready now, so the retry must open a
                    # fresh session rather than wait on it.
                    open_pending = False

    try:
        up = asyncio.create_task(upstream_task())
        loop_task = asyncio.create_task(session_loop())
        done, pending = await asyncio.wait(
            {up, loop_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for t in pending:
            t.cancel()
        for t in done:
            exc = t.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                raise exc
    except WebSocketDisconnect:
        logger.debug("Client disconnected normally")
    except Exception:  # noqa: BLE001
        logger.exception("Unexpected error in streaming tasks")
    finally:
        logger.info(
            "WebSocket handler exiting (answered %d turns, suppressed %d)",
            gate.answered_turns, gate.suppressed_turns,
        )
