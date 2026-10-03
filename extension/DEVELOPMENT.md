# Developing the text-caption extension

From the repository root, with Node.js 22.12+:

```sh
npm ci --prefix extension
npm run build --prefix extension
npm test --prefix extension
```

Load `extension/dist/live-translator-chrome` as an unpacked extension. The build bundles the desktop app's language grouping, text-only translation client, and safe caption renderer, so both clients use the same behavior. No remotely hosted JavaScript, inline executable code, API key, or Electron runtime is included.

`src/background.js` is a Manifest V3 service worker. Running state and the latest preview are kept in `chrome.storage.session`; preferences are kept in `chrome.storage.local`. Top-level event listeners allow the worker to wake after Chrome suspends it. Translation requests time out after 25 seconds, before Chrome's 30-second fetch-response lifetime limit. Stale requests are aborted and their originating document/selection is checked before showing a result.

Website permissions are optional and requested by the popup's Start button. Dynamic content scripts cover future navigations, and Start also injects into already-open tabs. Content scripts start at document start in isolated worlds in matching frames. Selection events are supplemented with a local 250 ms selection check for sites that consume events; unchanged text never causes another request. Restored pages resynchronize their running state. The popup can check the current page connection and re-inject the content script without waiting for slow subresources. Native `chrome.tabs` and `chrome.windows` state decides whether a selection can be translated. Captions are rendered as text in the top frame's Shadow DOM. No debugger permission is requested.

The browser integration test uses a disposable headless Chrome profile and a local fake translation server. Only the disposable test build receives host access at installation time, avoiding a native permission dialog in headless mode; the distributed manifest retains optional website permissions. Tests cover popup language groups, translation requests, safe rendering, excluded editors, cancellation, tab changes, frames, navigation, service-worker restart, and Stop. Set `CHROME_PATH` if Chrome is not installed at the standard macOS location. `LIVE_TRANSLATION=1 npm test --prefix extension` additionally verifies one caption against the hosted Gemini service and consumes its API quota.

Create a ZIP with the `live-translator-chrome` directory at its root after building. Commit only sources, icons, and lockfiles; `node_modules` and `dist` are ignored.
