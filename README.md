# Live Translator

Real-time audio translation powered by Gemini Live API. Speak in any language and hear the translation immediately. The default is **conversation mode**: a bidirectional interpreter between the two selected languages (97 languages, glossary), so two people can talk to each other. Toggling **Simul** switches to simultaneous translation mode (78 languages, auto-detect source language, one-way into the target). A one-way agent mode also exists on the server and is reachable from the test harness, but is no longer exposed in the UI.

![Demo](demo.gif)

## Getting Started

### Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) package manager
- [Gemini API key](https://aistudio.google.com/apikey)

### Setup

```bash
uv sync
```

Create `app/.env` with your API key:

```
GOOGLE_API_KEY=your-api-key
```

### Run

```bash
uv run uvicorn app.main:app --reload
```

Open http://localhost:8000.

## User Guide

### Basic Usage

1. Select the two conversation languages from the bottom bar
2. Click **Start** to begin continuous translation (always-on mode)
3. Speak into your microphone — translations appear as text bubbles and play as audio

Once audio is running, the same button becomes **Mute**/**Unmute**. Muting stops sending frames but keeps the microphone stream open, so unmuting is instant and never re-prompts for permission.

### Conversation (default)

The app runs as a **bidirectional interpreter** between the two selected languages, so two people can hold a live conversation. The model auto-detects which of the two languages each utterance is spoken in and speaks the translation in the *other* one — e.g. with English + Japanese selected, English speech is rendered in Japanese and Japanese speech in English, in the same session. The `⇄` between the two language dropdowns is a label, not a button: there is no direction to swap.

Details:
- Both language selectors stay visible (unlike Simul); pick the two conversation languages.
- Uses the agent model (`gemini-3.1-flash-live-preview`) with a bidirectional interpreter system instruction. The **glossary applies in either direction**.
- A single output voice speaks both directions (the Live session has one voice config).
- The system instruction includes an echo guard asking the model to ignore its own translated speech if the microphone picks it back up. This is a soft backstop — the browser's echo canceller handles the same-device case, and nothing handles a PA system. **Use headphones when you can.**

### Simultaneous Translation

Toggle **Simul** to switch to simultaneous translation mode. This uses the `gemini-3.5-live-translate-preview` model which auto-detects the source language — the source language selector is hidden and only a target language dropdown is shown. Translation is one-way, into the selected target language.

Differences from conversation mode:
- **Auto-detect**: no need to select a source language
- **78 languages** supported (vs 97)
- **No glossary**: custom term pinning is not available (display replacements still apply)
- **Idle timer**: since the model doesn't send turn-complete signals, transcription bubbles are finalized after 2 seconds of silence

Turning Simul back off returns you to conversation mode. Language selections are preserved when switching — codes are mapped automatically between the two language sets (e.g. `zh` ↔ `zh-Hans`).

### Push to Talk

Toggle **Push to Talk** on the right to switch from always-on to manual control. Hold the **Hold to Talk** button (or press spacebar) to transmit, release to stop.

### Voice & Audio Settings

Click **Voice & Audio** in the header to pick the microphone, the speaker, and the **translation voice** — one of the 30 prebuilt Gemini Live voices, listed with its tone (e.g. `Kore — Firm`, `Sulafat — Warm`). All three choices are saved in your browser.

The voice is part of the Live session's config, so switching it reconnects the session (the transcript is cleared). It applies to all three modes. Unknown voice names sent by a client are rejected server-side and fall back to the default (`Puck`), since the Live API refuses to connect on an unrecognised voice.

Microphone and speaker choices build a **priority list** rather than a single setting. Each device you pick moves to the top of its list (up to 10 remembered), and the app always uses the highest-ranked device that is actually attached. Whenever the attached set changes — a headset plugged in, a dock removed — the list is re-evaluated and the pipeline switches to the new best device mid-session, so losing the mic in use drops to your next favourite instead of the system default. Choosing **System Default** is treated as a deliberate opt-out and clears the list.

Each entry stores **both `deviceId` and label**. A `deviceId` is perishable — the browser re-salts it when site permissions are cleared, and some devices come back with a new one after a replug — so if the saved id no longer resolves, the device is matched by name and the stored id is repaired in place, keeping its rank. Entries for absent devices are kept, so plugging one back in reclaims its position.

### Glossary

Click **Glossary** in the header to pin specific terms to fixed translations. The glossary is per-browser (stored in `localStorage`) and sent to the server on each new session.

Upload a UTF-8 CSV with `source,target[,transcription]` per line:

```csv
Kubernetes,クバネティス,Kubernetes
Cloud Run,クラウドラン,Cloud Run
Vertex AI,バーテックスエーアイ,Vertex AI
```

The optional third column is a display override — the model pronounces the `target` form, but the on-screen transcript shows the `transcription` form. Useful for proper nouns where you want phonetic audio but a Latin display label.

Changes take effect on the next session (click **Start** again, or change languages).

#### Changing the default glossary

Edit `app/dict.csv` and redeploy. Browsers with a cached glossary keep using it until the user clicks **Reset to defaults** in the modal.

### Caption Overlay

Overlay translated subtitles on top of any window — useful for presentations at onsite events or screen sharing via Google Meet. Click **Caption** in the header to open the caption page, or navigate to `/caption` manually.

![Caption Overlay](caption.png)

1. Open the main app in Chrome and click **Start** to begin translating
2. Click **Caption** in the header — a new window opens with a "Select Window" button
3. Click **Select Window** and pick the window to mirror (e.g. your slides, Keynote, or any app)
4. The selected window's content streams into the caption page with translated subtitles at the bottom
5. Click the **⛶ Fullscreen** button in the top-right (or press **F** / double-click) to fill the screen
6. Share this caption window on Google Meet — participants see your slides with live subtitles

Fullscreen needs its own click, separate from *Select Window*: `requestFullscreen()` consumes the transient user activation that `getDisplayMedia()` also requires, and the window picker preempts an in-flight fullscreen transition. Hence the dedicated button, which appears once mirroring starts and fades out after 4 seconds so it stays off your slides — move the mouse to bring it back. **Esc** exits, as does stopping the screen share.

The caption page uses the [Screen Capture API](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API) to mirror the target window and the [BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) to receive transcription from the main page, so both pages must run in the same browser. No OBS or third-party tools needed.

### Connection States

The status indicator in the top-right corner shows:
- **Yellow dot / Connecting...** — WebSocket connecting
- **Green dot / Connected** — ready to translate
- **Red dot / Disconnected** — connection lost, auto-reconnects in 5s

---

## Technical Details

### Sequence Diagram

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Server (FastAPI)
    participant G as Gemini Live API

    B->>S: WS /ws/{user}/{sid}?src&tgt[&simul]
    B->>S: JSON setup {glossary, voice}
    S->>G: live.connect(sysInstruction, speechConfig)

    rect rgb(240, 248, 255)
    note over B,G: Translation loop (repeat per utterance)
    B->>S: binary PCM 16kHz
    S->>G: send_realtime_input(audio)
    G-->>S: input and output transcriptions
    S-->>B: {inputTranscription}, {outputTranscription}
    G-->>S: model_turn audio chunk
    S-->>B: {content.parts[inlineData]}
    G-->>S: turn_complete
    S-->>B: {turnComplete}
    end

    B->>S: WS close
    S->>G: session close
```

FastAPI bridges one browser WebSocket to a series of Gemini Live API sessions. The browser WS lives for the lifetime of the user's tab; upstream Live sessions are opened, expire (~15 min), and reopened underneath it transparently.

**Connection lifecycle:**

1. Browser opens WebSocket to `/ws/{user_id}/{session_id}` and sends a JSON setup frame with the per-browser glossary
2. Server builds a system instruction embedding the glossary and language pair
3. Two background coroutines run concurrently:
   - **session_loop** opens a Gemini Live session, drains messages from it, and forwards them as JSON envelopes to the browser
   - **upstream_task** forwards binary audio frames from the browser WS to whichever upstream session is current
4. When the upstream session sends a GoAway (observed `time_left=50s`), the server immediately starts opening the next session in the background while continuing to drain the current one — this eliminates dead time between sessions
5. Once the old session finishes, the pre-opened session takes over seamlessly

**Wire format:** Each `LiveServerMessage` is translated into a camelCase JSON envelope the frontend understands (`turnComplete`, `inputTranscription`, `outputTranscription`, `content.parts[]`, `usageMetadata`).

**Transcription behavior:** Output transcription (the translated speech) streams in multiple partial chunks, so the UI can show word-by-word updates with a typing indicator. Input transcription (the user's spoken words) arrives as a single message with the complete text — the API does not stream partial input transcriptions, so the user's bubble appears all at once.

### Models

**Agent mode** uses `gemini-3.1-flash-live-preview` via the Gemini API (`generativelanguage.googleapis.com`). The system instruction (built in `app/translator_agent/agent.py`) tells the model to translate only the current utterance and never repeat previous translations. The glossary is embedded as `source → target` pairs with case-insensitive matching.

**Simultaneous translation mode** uses `gemini-3.5-live-translate-preview` with a `TranslationConfig` instead of system instructions. The config specifies `target_language_code` and `echo_target_language=False`. This model auto-detects the source language and does not support tools, glossary, or system instructions — so the prompt-level echo guard is unavailable here, and `echo_target_language=False` takes its place: the model stays silent on input that is already in the target language rather than parroting it. That matters because the model's own output is, by construction, in the target language, so with `True` a speaker feeding the microphone produced a self-sustaining feedback loop. The tradeoff is that a human genuinely speaking the target language gets no audio out, which is the desired behaviour for one-way simultaneous translation.

**Conversation mode** (the UI default) reuses the agent model (`gemini-3.1-flash-live-preview`) but with a bidirectional interpreter system instruction (`build_conversation_instruction` in `app/translator_agent/agent.py`): it tells the model to detect which of the two configured languages each utterance is in and reply in the other. The WebSocket carries a `convo=true` query param; the glossary is embedded bidirectionally (`source ↔ target`). Without that param the server falls back to one-way agent mode (`build_system_instruction`), which the UI no longer requests but the test harness still exercises.

Both system-instruction builders end with an **echo guard** (`_ECHO_GUARD`) asking the model to stay silent when an utterance is its own earlier output coming back through the speakers. It is a hint, not a guarantee: the model has no ground truth for what it emitted, and its false-positive mode is dropping a real utterance.

Audio input is 16 kHz mono PCM; output is 24 kHz PCM (both modes).

### GoAway Handling

Gemini Live sessions do not last indefinitely. In 30-minute soaks a GoAway arrived every ~9 minutes, always with `time_left=50s`. When the server receives one:

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Server (FastAPI)
    participant O as Old Session
    participant N as New Session

    O-->>S: GoAway (time_left=50s)
    S->>N: live.connect() (pre-open in background)
    note over S,O: drain old session — continue forwarding messages
    O-->>S: outputTranscription / audio chunks
    S-->>B: {outputTranscription} / {content}
    O-->>S: turn_complete
    S-->>B: {turnComplete}
    note over S: old session done, switch to new session
    B->>S: binary PCM 16kHz
    S->>N: send_realtime_input(audio)
```

1. A new session starts opening immediately in the background (`_open_next()`), ready in ~200ms
2. The old session continues draining — any in-progress translation completes and is forwarded to the browser
3. After the old session ends, the pre-opened session becomes the active session
4. Audio from the browser is routed to the new session with no gap

A drain that never finishes its turn is the awkward case: waiting out the whole 50s deadline is dead air the listener hears in full. Two thresholds bound it, both measured from the last frame actually forwarded to the browser (heartbeats don't count, so a turn genuinely in flight is never clipped):

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as Server (FastAPI)
    participant O as Old Session
    participant N as New Session

    O-->>S: GoAway (time_left=50s)
    S->>N: live.connect() (pre-open in background)
    note over S,O: drain — but the old session stops answering
    B->>S: binary PCM 16kHz
    note over S: every frame kept in recent_audio (~10s ring)
    note over S,O: quiet 3s → drain declared stalled
    S->>N: replay unanswered audio, then tee live audio
    note over S,O: quiet 5s → cut over
    S-->>B: {turnComplete} (closes the abandoned caption)
    note over S: new session adopted — already warm
```

5. At `DRAIN_MIRROR_QUIET_SEC` (3s of quiet) the drain is treated as stalled and the microphone is teed into the replacement as well — speech going into a session that has stopped answering still reaches one that hasn't
6. At `GOAWAY_IDLE_GRACE_SEC` (5s of quiet) the swap happens, instead of waiting out the deadline. The abandoned turn will never report itself complete, so the server sends a synthetic `turnComplete` to close the caption the client left open
7. If a mirrored drain recovers and completes its turn after all, the replacement is discarded and a fresh one opened — it heard audio the old session went on to answer, so keeping it would mean translating the same words twice

What gets replayed into a replacement is decided by one rule: **the audio captured since the outgoing session last said anything.** Nothing was relayed after that point, so none of it has been translated, and anything older has been — replaying that too would translate the same words twice. `recent_audio` keeps every mic frame with its arrival time for ~10s so the cut can be made at that boundary rather than at a fixed offset.

This also covers the case the thresholds alone miss: a GoAway that lands mid-sentence on a session that had already been quiet for longer than the grace. The cutover then happens within milliseconds and the mirror never attaches, but the sentence so far is still owed to the replacement, and is handed to it the moment it is adopted.

**What it costs the listener.** Across 11 GoAways observed in soak testing (two 30-minute local runs and one 1-hour Cloud Run run), a GoAway takes one of four paths:

| Path | Observed | Effect |
|---|---|---|
| Old session finishes its turn | — | none — the swap happens between turns, mic audio keeps flowing to the dying session throughout |
| Drain stalls, then recovers and completes its turn | 5 | none to the listener. The mirrored replacement heard audio the old session went on to answer, so it is discarded and a fresh one opened (~190ms, off the critical path) |
| Drain stalls and never recovers | 3 | up to 5s before the translation lands, and only in a window where nothing was being delivered anyway. All three landed between utterances with no audio owed. The mirror means the replacement has been working on that audio for the last 2s, so it flushes shortly after the swap rather than starting cold |
| GoAway lands mid-sentence on an already-quiet session | 3 | cutover in 2–4ms, the sentence so far (1.4–3.5s of audio) replayed 83–197ms later. All three iterations scored 10/10 at normal latency. Before the replay was added, all but the last word of that sentence was lost |

The soak speaks one sentence every ~17s with quiet gaps in between, which biases heavily towards the stalled paths — continuous speech keeps the drain talking and takes the first row far more often than these counts suggest.

The speaker never has to pause or repeat — every frame is captured regardless of which session is live. On the two cutover paths the seam is visible rather than audible: the synthetic `turnComplete` closes the caption the abandoned turn left open, and the replacement's translation of the same audio appears as a new caption below it.

**Watch out for turn accounting.** The synthetic `turnComplete` is a turn boundary with no turn behind it. Anything pairing utterances 1:1 with turn boundaries over a long-lived socket will sit one turn behind for the rest of the connection once a cutover happens — the soak test did exactly this and reported 68% while translation itself was perfect. `tests/test_long.py` now flushes frames belonging to a turn it gave up on and rejects a boundary with no content in front of it; the browser client is unaffected because `finalizeTurn()` on an already-closed caption is a no-op.

**Limitations:**

- The model on the new session has no context from the previous one, so it starts fresh. The replay covers the audio, not the history.
- On the cutover paths, mic audio arriving between the cutover and the adoption of the replacement (83–197ms observed) is still dropped: `pending_preroll` is captured as bytes at cutover, so frames landing during the wait are not in it. Capturing the cut timestamp instead and building the replay at adoption would close this.

Session resumption was intentionally removed — it caused an off-by-one translation cascade where the model would prepend the previous turn's translation to the current one. Without resumption, each session starts clean, which proved more reliable (98% pass rate vs 65% with resumption in 1-hour soak tests).

### Gemini Live API Transient Errors and Recovery

The Gemini Live API occasionally returns `1011 (service currently unavailable)` errors. Before the recovery fix, production logs showed ~20 errors per 24 hours in two patterns:

- **Mid-session kill** (~65% of cases): An active session is disconnected during `session.receive()`. The session was working, then Gemini drops it.
- **Connect-time rejection** (~35% of cases): Gemini refuses to open a new session entirely. This typically follows a mid-session kill — the retry fails because Gemini is still recovering.

These errors cascaded: a mid-session kill triggered a retry with a flat 1s delay, which was often also rejected because Gemini was still unavailable. The session connect call had no timeout, so it could hang indefinitely on unresponsive connections.

**Recovery logic in `session_loop`:**

1. **Connect timeout** (`CONNECT_TIMEOUT_SEC = 10`): The `conn.__aenter__()` call has a hard timeout so a hanging connect fails fast instead of blocking indefinitely.
2. **Exponential backoff**: Retries start at 0.2s and double on each consecutive failure, capping at 4s. The backoff resets after a successful session. This avoids thrashing the API while still recovering quickly from transient blips.
3. **Transparent reconnect**: The browser WebSocket stays open during retries — only the upstream Gemini session is affected. Once a new session opens, `upstream_task` resumes forwarding audio to it automatically.
4. **No deadlock on the retry path**: `next_ready` is set only by the GoAway pre-open. Waiting on it when no open is in flight — after a session error, say — parked the loop forever, so the wait is gated on an `open_pending` flag and the error path clears it. This showed up in production as the app going unresponsive until the browser reconnected.

After the fix, production logs showed 1 error in 15 hours (vs ~12 in the same period before), with zero connect-time rejections — the faster initial retry reconnects before the cascading failure pattern kicks in.

For real users streaming from a microphone, recovery is seamless — the new session picks up the live audio stream with a brief gap. For health checks that send a one-shot audio clip, the clip may be lost if the session dies before producing a response.

### SDK Note

`app/main.py` clears `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION` before constructing the genai client. These env vars cause the SDK to route through `aiplatform.googleapis.com`; clearing them forces Gemini API key routing via `generativelanguage.googleapis.com`.

### Deployment to Cloud Run

```bash
set -a && source app/.env && set +a

gcloud run deploy live-translation \
  --source . \
  --project YOUR_PROJECT \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout 3600 \
  --min-instances 1 \
  --max-instances 1 \
  --set-env-vars "GOOGLE_API_KEY=${GOOGLE_API_KEY}"
```

Key flags:
- `--timeout 3600` — allows hour-long WebSocket conversations (upstream Live sessions cycle internally every ~15 min)
- `--min-instances 1` — avoids cold start latency
- `--max-instances 1` — session resumption handles are stored in-memory; multi-replica requires a shared store (e.g. Redis)

## Testing

### Soak Test

`tests/test_long.py` validates translation quality, latency, glossary behavior, and session stability over extended periods (default 1 hour).

It generates random English sentences via Gemini Flash Lite, converts them to audio with Google Cloud TTS, streams them through the translator WebSocket, transcribes the returned audio with Google Cloud STT, and verifies semantic correctness.

```bash
uv sync --extra test

# 2-minute smoke test against local server
uv run python tests/test_long.py --duration 120

# 1-hour test against Cloud Run
uv run python tests/test_long.py --url wss://YOUR_CLOUD_RUN_URL --duration 3600
```

Options: `--url` (WebSocket base URL), `--duration` (seconds), `--source`/`--target` (language pair), `--mode` (`convo`, the app default, or `agent` for the one-way path), `--log` (JSONL output path).

#### Latest soak test results (1 hour, en → ja, Cloud Run)

Recorded in **agent mode**, before conversation mode became the default and before the echo guard was added to the system instruction. A 150-second convo-mode smoke run scored 9/9 at avg 10.0/10 with 0 errors, but a full-hour convo-mode soak has not been run.

Six GoAways at a ~9-minute cadence, covering all three drain paths: two instant cutovers that replayed unanswered audio (84,992 and 44,032 bytes, delivered 93ms and 83ms after the GoAway), two stalled drains that recovered and had their mirrored replacement discarded, and two silent cutovers between utterances with nothing owed. Every iteration spanning one scored 10/10 at normal latency. The single failure is the last iteration, truncated by the duration limit.

```
Duration: 3633s | Iterations: 207 | Passed: 206/207 (99.5%) | Avg score: 9.9/10 | Errors: 0

  Translation Score (n=207)
  min=6.00  avg=9.90  p50=10.00  p90=10.00  p99=10.00  max=10.00
         0-2:    0 (  0.0%) 
         3-4:    0 (  0.0%) 
         5-6:    1 (  0.5%) 
         7-8:    3 (  1.4%) 
        9-10:  203 ( 98.1%) ##############################

  Glossary Iteration Score (n=69)
  min=6.00  avg=9.90  p50=10.00  p90=10.00  p99=10.00  max=10.00
         0-2:    0 (  0.0%) 
         3-4:    0 (  0.0%) 
         5-6:    1 (  1.4%) 
         7-8:    1 (  1.4%) 
        9-10:   67 ( 97.1%) ##############################

  First Response (speech-end to first audio/transcript) (n=207)
  min=0.00  avg=0.02  p50=0.00  p90=0.07  p99=0.41  max=0.51
         =0s:  142 ( 68.6%) ##############################
      0-0.1s:   52 ( 25.1%) ##########
    0.1-0.5s:   12 (  5.8%) ##
      0.5-1s:    1 (  0.5%) 
        1-2s:    0 (  0.0%) 
        2-5s:    0 (  0.0%) 
         >5s:    0 (  0.0%) 

  Turn Complete (speech-end to full translation) (n=206)
  min=3.39  avg=5.21  p50=5.21  p90=6.14  p99=7.11  max=7.18
         <2s:    0 (  0.0%) 
        2-3s:    0 (  0.0%) 
        3-4s:   12 (  5.8%) ##
        4-5s:   65 ( 31.6%) ###############
        5-7s:  126 ( 61.2%) ##############################
       7-10s:    3 (  1.5%) 
        >10s:    0 (  0.0%) 

  Input Transcription Score (n=207)
  min=4.00  avg=9.94  p50=10.00  p90=10.00  p99=10.00  max=10.00
         0-2:    0 (  0.0%) 
         3-4:    1 (  0.5%) 
         5-6:    0 (  0.0%) 
         7-8:    0 (  0.0%) 
        9-10:  206 ( 99.5%) ##############################

  Output Transcription Score (n=207)
  min=4.00  avg=9.56  p50=10.00  p90=10.00  p99=10.00  max=10.00
         0-2:    0 (  0.0%) 
         3-4:    1 (  0.5%) 
         5-6:    4 (  1.9%) 
         7-8:   20 (  9.7%) ###
        9-10:  182 ( 87.9%) ##############################

  Total Iteration Time (n=207)
  min=13.68  avg=17.55  p50=17.38  p90=19.37  p99=21.03  max=45.33
        <10s:    0 (  0.0%) 
      10-15s:   10 (  4.8%) #
      15-20s:  184 ( 88.9%) ##############################
      20-25s:   12 (  5.8%) #
      25-30s:    0 (  0.0%) 
        >30s:    1 (  0.5%)
```

