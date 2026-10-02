# Live Translator desktop

A standalone local app that translates selected Chrome page text using the existing Live Translator server and places the translated caption on that same tab. No extension, microphone, screen capture, or local Gemini API key is required.

## Run the Mac app

Build the app using the commands under [Develop and build](#develop-and-build).
On an Apple Silicon Mac, open `dist/Live Translator-darwin-arm64/Live Translator.app`
from this directory. You can copy it to your Applications folder. Build outputs
are not included in the repository. This is an unsigned development build, not
a notarized public release.

1. In Chrome 144 or later, open `chrome://inspect/#remote-debugging` and enable remote debugging.
2. Open **Live Translator**, choose the source and target languages, and click **Start captions**.
3. Allow the debugging connection in Chrome when it asks.
4. Switch to a normal web page and select text. After the selection settles for 600 ms, its translation appears at the bottom of the page.
5. **Stop**, or quit the app, to remove captions and disconnect. Your Chrome tabs stay open.

The app follows the focused tab in the foreground Chrome window. Changing the selection, switching tabs, clearing the selection, or navigating cancels the previous request and removes its caption. A caption stays while its selection remains active. To retry a failed translation, clear the selection and select it again.

**Connection settings** lets you choose the server (Tokyo is the default). Leave the Chrome endpoint blank to discover the running browser through Chrome's remote debugging setting. You can also enter a local endpoint such as `http://127.0.0.1:9222` or the browser's full `ws://127.0.0.1:PORT/devtools/browser/...` address. For the settings-based server, the app reads Chrome's `DevToolsActivePort` file and connects over IPv4; the same discovery is used when a manually entered HTTP endpoint matches that port. This avoids both the missing `/json/version` route and accidentally connecting to a different Chrome instance listening on IPv6 at the same port.

For a separate, manually launched Chrome profile on macOS:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.live-translator-chrome"
```

Use `http://127.0.0.1:9222` in the app for this launch method. Keep the debugging endpoint on localhost.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Chrome has not published its debugging endpoint | Enable remote debugging in your running Chrome's settings page. A separate profile launched from the command line may need an explicit endpoint. |
| Connection is waiting or times out | Check Chrome for a connection approval dialog. **Stop** also cancels an in-progress connection; then try **Start captions** again. |
| Chrome discovery returns HTTP 404 | Leave the endpoint blank for the settings-based server. Its debugging port does not provide the traditional `/json/version` API. |
| Chrome disconnected | Keep Chrome open and click **Start captions** to reconnect. |
| No caption appears | Focus the source Chrome window and select ordinary page text. Input fields, editors, internal pages, and the PDF viewer are excluded. |
| Update the translation server | Use a server version that includes `POST /api/translate`, or select one of the hosted endpoints listed in the [main README](../README.md#desktop-captions-for-selected-text). |
| Translation fails | Check the server connection, then clear and reselect the text to retry. Oversized passages must be shortened to 10,000 characters or fewer. |

## What is sent and displayed

Only selected document text (up to 10,000 characters) is sent to the configured translation server while the app is running. Input, textarea, and contenteditable selections are excluded. Captions use a separate Shadow DOM and render translation as text, never HTML. Text and translations are not persisted; only connection and language preferences are saved locally. The server processes selected text through Gemini, as it does for the web app's translations.

HTTP/HTTPS document pages and accessible frames are supported. Chrome internal pages, the browser's PDF viewer, canvas-only content, and pages without selectable DOM text are outside this version's scope. If Chrome disconnects, click **Start captions** to reconnect. Site navigation or modal/fullscreen behavior can affect caption visibility.

The client uses `/api/languages` and `POST /api/translate`. Selected text is translated with `gemini-3.5-flash-lite` through the text generation API. HTTP connections can be reused; no Live session is opened and no audio is generated. Translation is one-way into the chosen target language. No MCP server or LLM agent runs locally. The server must include the `/api/translate` endpoint; an older server produces an update-required message rather than silently falling back to Live.

To run your own server, follow the [repository setup instructions](../README.md#getting-started), then set the app's server URL to `http://localhost:8000`. The API key stays on that server. `TEXT_TRANSLATION_MODEL` defaults to `gemini-3.5-flash-lite`; `GET /api/languages` reports it as `textModel`.

## Develop and build

Node.js 22.12+ (or a newer supported Node release) and Chrome are required for development. The packaged app includes its own runtime; users do not need Node or Python.

```sh
cd desktop
npm ci
npm start
npm test
npm run package
```

If your npm configuration disables install scripts, run `node node_modules/electron/install.js` after installing dependencies. Packaging produces a native app for the build machine's platform and architecture under `dist/`.

Offline tests cover text-only HTTP requests, cancellation, timeout, validation, Chrome endpoint discovery, literal caption rendering, focused-tab tracking, iframe selection, navigation, and cleanup. Browser tests use a disposable headless Chrome profile; set `CHROME_PATH` if Chrome is not at the standard macOS path. They skip when Chrome is not installed there.

An explicit smoke test uses the deployed translation service (and its API quota):

```sh
node test/live-smoke.mjs
# Optional: TRANSLATOR_SERVER=https://your-service.example node test/live-smoke.mjs
```

Reference: [Chrome's automatic debugging connection](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#automatically-connecting-to-a-running-chrome-instance), [Puppeteer connection options](https://pptr.dev/api/puppeteer.connectoptions).
