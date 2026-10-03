# Text Live Translator for Chrome

Select text on a web page and see its translation as a caption on the same page. Text Live Translator automatically translates between your two chosen languages, so you can read English and Japanese pages without switching settings.

## What you need

- An Apple Silicon Mac with the **Text Live Translator** app.
- Google Chrome with the remote debugging option available. Chrome 150 or later is recommended for reliable tab switching when other browser automation tools are connected.
- An internet connection.

You do not need a browser extension, microphone, API key, or developer tools installed. There is no need to download the source code.

To update from **Live Translator**, quit the old app and replace it with **Text Live Translator.app**. Your saved language and connection settings are preserved.

## First-time setup

1. [Download Text Live Translator for Mac (Apple Silicon)](https://github.com/kazunori279/live-translator/releases/download/desktop-v0.1.4/Text-Live-Translator-mac-arm64.zip). This build supports Macs with an M-series chip; it does not support Intel Macs or Windows.
2. Open the downloaded ZIP, then drag **Text Live Translator.app** to your **Applications** folder and open it.
3. If macOS blocks the app, follow [Opening the app on macOS](#opening-the-app-on-macos) below: **System Settings → Privacy & Security → Open Anyway**.
4. Click the `chrome://inspect/#remote-debugging` link in Text Live Translator to open Chrome’s setup page. You can also paste that address into Chrome’s address bar.
5. Enable **Allow remote debugging for this browser instance**. Keep Chrome open. A message such as `Server running at: 127.0.0.1:9222` means it is ready.
6. Return to Text Live Translator and choose **Language 1** and **Language 2**.
7. Click **Start captions**. Chrome may display a dialog asking whether to allow a remote debugging connection. Bring Chrome to the front if the dialog is hidden behind Text Live Translator.
8. If you just started Text Live Translator, click **Allow** in Chrome’s dialog. This lets Text Live Translator read your selected text and display captions on the page. Remote debugging grants broad control of the browser, so only approve connection requests you recognize. This approval is separate from enabling remote debugging in Chrome’s settings.
9. Return to Text Live Translator and wait for **Running**. If you cancel or deny the dialog, click **Stop**, then **Start captions** to try again.

Leave **Connection settings** at their defaults for normal use.

### Opening the app on macOS

This app is **not Apple-notarized or Developer ID signed**. Version 0.1.2 and later have an ad-hoc signature that checks the app’s integrity, but does not identify a developer trusted by Apple. macOS may block the first launch.

If you trust this app and downloaded it from the GitHub release linked above:

1. Open **Text Live Translator.app** from **Applications** once. If macOS blocks it, dismiss the message.
2. Open the **Apple menu → System Settings → Privacy & Security**.
3. Scroll to the **Security** section and find the message about Text Live Translator being blocked.
4. Click **Open Anyway**. Authenticate with Touch ID or your Mac password if prompted.
5. Confirm **Open** in the next dialog. Text Live Translator should launch.

This allows this app specifically; do not disable Gatekeeper system-wide. See [Apple’s instructions for opening apps safely](https://support.apple.com/102445).

Versions 0.1.0 and 0.1.1 had an invalid bundle signature and could display “damaged” or “move to Trash.” Replace those versions with the current download. If the new version still reports damage or does not offer **Open Anyway**, stop and report the macOS version and exact message; do not override a malware warning.

## Translate a web page

Bring your Chrome tab to the front and select a sentence or paragraph. Pause briefly after selecting it; the translation appears near the bottom of the page and in the app's **Latest translation** panel.

With **English ⇄ Japanese** selected:

- English text is translated into Japanese.
- Japanese text is translated into English.
- Text in another language is translated into **Language 2**, Japanese in this example.

Each language menu starts with ten popular choices: English, Japanese, Chinese, Spanish, French, German, Portuguese, Korean, Hindi, and Arabic. All other available languages appear below them in alphabetical order. Your language choices are remembered the next time you open the app.

To change languages, click **Stop**, choose a new pair, then click **Start captions** again. Choosing the language already on the other side swaps the pair.

Select a new passage to translate something else. Clearing the selection, switching tabs, or going to another page removes the previous caption. Click **Stop**, or quit Text Live Translator, when you are finished. Your Chrome tabs stay open.

## If something does not work

| Problem | Try this |
| --- | --- |
| The app cannot find Chrome | Keep Chrome open and check that remote debugging is enabled on the page used during setup. Leave **Chrome endpoint** blank under **Connection settings**. |
| The app stays on Connecting | Bring Chrome to the front and look for its remote debugging permission dialog. Click **Allow** for the connection you just started with Text Live Translator. If you dismissed or denied it, click **Stop**, then **Start captions** to retry. |
| Chrome disconnected | Reopen Chrome if needed, then click **Start captions** again. |
| No caption appears | Bring the page to the front and select ordinary page text. Text inside images, PDFs, text boxes, and editors is not supported. Chrome settings pages are also excluded. |
| Translation fails or times out | Check your internet connection. Clear the selection and select it again. Try a shorter passage; the limit is 10,000 characters. |
| The translation goes in the wrong direction | Check your two selected languages. Very short or mixed-language selections may be ambiguous; select a complete sentence for more context. |

If you were given a specific Chrome connection address, enter it under **Connection settings → Chrome endpoint**. Otherwise, leave that field blank.

The default translation server is in Tokyo. If your app provider asks you to change it, use **Connection settings → Translation server**.

| Server | Address |
| --- | --- |
| Tokyo (default) | `https://live-translation-761793285222.asia-northeast1.run.app` |
| US Central | `https://live-translation-761793285222.us-central1.run.app` |

## Privacy

While captions are running, selected page text is sent to the translation server and processed by Google's Gemini service. Avoid selecting text you do not want to send for translation. The app does not send the entire page, record audio, or capture your screen.

The app saves your language and connection preferences locally, but does not save a translation history. Selections in text boxes and editable areas are excluded. Click **Stop** to disconnect from Chrome and stop translating selections.
