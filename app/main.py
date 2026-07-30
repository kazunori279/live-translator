"""FastAPI application for real-time live translation using the Gemini Live API."""

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
from translator_agent import (  # noqa: E402
    DEFAULT_VOICE,
    LANGUAGES,
    MODEL,
    POPULAR_LANGUAGES,
    SIMUL_LANGUAGES,
    SIMUL_MODEL,
    SIMUL_POPULAR_LANGUAGES,
    VOICES,
    build_conversation_instruction,
    build_system_instruction,
    load_default_glossary,
    resolve_voice,
    simul_language_code,
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
# chunks from having the same sentence translated twice, once by each; the
# audio it missed is replayed on attach, so waiting costs no coverage, only
# realtime warm-up for the replacement.
DRAIN_MIRROR_QUIET_SEC = 3.0
# Mic frames kept for replay into a replacement session. ~125 frames/sec of
# 512 bytes, so this is ~10s and ~320KB; what actually gets replayed is only
# the audio the outgoing session never answered, which is bounded by
# GOAWAY_IDLE_GRACE_SEC and so always well inside the window.
RECENT_AUDIO_MAX_FRAMES = 1250
AUTHOR = "live_translator"  # constant author tag echoed in every server frame

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


logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Suppress Pydantic serialization warnings emitted by the genai SDK.
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

app = FastAPI()

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")

client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])


@app.get("/")
async def root():
    """Serve the index.html page."""
    return FileResponse(Path(__file__).parent / "static" / "index.html")


@app.get("/caption")
async def caption():
    """Serve the caption overlay page (window mirror + subtitles)."""
    return FileResponse(Path(__file__).parent / "static" / "caption.html")


@app.get("/api/languages")
async def get_languages():
    """Return available languages with popular ones highlighted."""
    return {
        "languages": LANGUAGES,
        "popular": POPULAR_LANGUAGES,
        "model": MODEL,
        "simulModel": SIMUL_MODEL,
        "simulLanguages": SIMUL_LANGUAGES,
        "simulPopular": SIMUL_POPULAR_LANGUAGES,
        "voices": VOICES,
        "defaultVoice": DEFAULT_VOICE,
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
    source: str = "en",
    target: str = "ja",
    simul: bool = False,
    convo: bool = False,
) -> None:
    """WebSocket endpoint bridging browser audio to a Gemini Live session."""
    logger.info(
        "WS request: source=%s, target=%s, simul=%s, convo=%s",
        source, target, simul, convo,
    )
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

    if simul:
        active_model = SIMUL_MODEL
        system_instruction = None
        target_code = simul_language_code(target)
        logger.info(
            "Simultaneous mode: model=%s, target=%s, target_code=%s",
            active_model, target, target_code,
        )
    else:
        if convo:
            system_instruction = build_conversation_instruction(
                source, target, glossary_entries
            )
            logger.info("Conversation mode: %s <-> %s", source, target)
        else:
            system_instruction = build_system_instruction(
                source, target, glossary_entries
            )
        target_code = None
        active_model = MODEL

    logger.info("Output voice: %s", voice)

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

    async def upstream_task() -> None:
        """Forward browser audio into whichever Live session is current."""
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
                    logger.debug("Ignoring text message (audio-only)")
        except WebSocketDisconnect:
            logger.debug("Upstream: client disconnected")

    async def session_loop() -> None:
        """Open Gemini Live sessions in succession, replacing on GoAway."""
        nonlocal current_session, mirror_session

        def _build_config():
            kwargs = dict(
                response_modalities=[types.Modality.AUDIO],
                input_audio_transcription=types.AudioTranscriptionConfig(),
                output_audio_transcription=types.AudioTranscriptionConfig(),
                # Both models accept the same prebuilt voice set.
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(
                            voice_name=voice
                        )
                    )
                ),
            )
            if simul:
                kwargs["translation_config"] = types.TranslationConfig(
                    target_language_code=target_code,
                    echo_target_language=True,
                )
            else:
                kwargs["system_instruction"] = types.Content(
                    parts=[types.Part(text=system_instruction)]
                )
            cfg = types.LiveConnectConfig(**kwargs)
            logger.debug("LiveConnectConfig: %s", cfg.model_dump(exclude_none=True))
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
                conn = client.aio.live.connect(model=active_model, config=cfg)
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
                    conn = client.aio.live.connect(model=active_model, config=cfg)
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
                            ot = envelope.get("outputTranscription")
                            if ot and ot.get("text") and display_map:
                                original = ot["text"]
                                replaced = _apply_display_map(
                                    original, display_map
                                )
                                if replaced != original:
                                    logger.debug(
                                        "Display map: %r -> %r",
                                        original,
                                        replaced,
                                    )
                                ot["text"] = replaced
                            await websocket.send_text(
                                json.dumps(envelope)
                            )
                            last_relay_at = loop.time()
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
                            # would say it all over again. Throwing the session
                            # away costs one fresh connect; sorting its queued
                            # output apart from the next real turn costs more.
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
                        if mirror_session is None:
                            # Cut over before the mirror could attach — the
                            # GoAway can land while the speaker is mid-sentence
                            # and the session, quiet for a while already, gets
                            # dropped a few milliseconds later. Nothing was
                            # relayed after last_relay_at, so audio from that
                            # point on went unanswered and is owed to the
                            # replacement; anything earlier was answered and
                            # replaying it would translate it twice.
                            pending_preroll = _audio_since(last_relay_at)
                        # The abandoned turn will never report itself complete,
                        # and the client keeps appending to an open caption
                        # until something does. Close it before the next
                        # session starts a turn of its own.
                        try:
                            await websocket.send_text(
                                json.dumps(
                                    {"turnComplete": True, "author": AUTHOR}
                                )
                            )
                        except Exception:  # noqa: BLE001
                            pass
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
        logger.debug("WebSocket handler exiting")
