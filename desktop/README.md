# Live Translator for Chrome

Select text on a web page and see its translation as a caption on the same page. Live Translator automatically translates between your two chosen languages, so you can read English and Japanese pages without switching settings.

## What you need

- An Apple Silicon Mac with the **Live Translator** app.
- Google Chrome with the remote debugging option available.
- An internet connection.

You do not need a browser extension, microphone, API key, or developer tools installed. There is no need to download the source code.

## First-time setup

1. [Download Live Translator for Mac (Apple Silicon)](https://github.com/kazunori279/live-translator/releases/download/desktop-v0.1.0/Live-Translator-mac-arm64.zip). This build supports Macs with an M-series chip; it does not support Intel Macs or Windows.
2. Open the downloaded ZIP, then drag **Live Translator.app** to your **Applications** folder and open it.
3. In Chrome, paste `chrome://inspect/#remote-debugging` into the address bar.
4. Enable **Allow remote debugging for this browser instance**. Keep Chrome open. A message such as `Server running at: 127.0.0.1:9222` means it is ready.
5. Return to Live Translator and choose **Language 1** and **Language 2**.
6. Click **Start captions**. If Chrome asks to allow the connection, approve it for Live Translator. Wait for the app to show **Running**.

Leave **Connection settings** at their defaults for normal use. The current Mac build is unsigned and has not been notarized by Apple. If macOS prevents it from opening, contact the person who supplied it for installation help.

## Translate a web page

Bring your Chrome tab to the front and select a sentence or paragraph. Pause briefly after selecting it; the translation appears near the bottom of the page and in the app's **Latest translation** panel.

With **English ⇄ Japanese** selected:

- English text is translated into Japanese.
- Japanese text is translated into English.
- Text in another language is translated into **Language 2**, Japanese in this example.

Each language menu starts with ten popular choices: English, Japanese, Chinese, Spanish, French, German, Portuguese, Korean, Hindi, and Arabic. All other available languages appear below them in alphabetical order. Your language choices are remembered the next time you open the app.

To change languages, click **Stop**, choose a new pair, then click **Start captions** again. Choosing the language already on the other side swaps the pair.

Select a new passage to translate something else. Clearing the selection, switching tabs, or going to another page removes the previous caption. Click **Stop**, or quit Live Translator, when you are finished. Your Chrome tabs stay open.

## If something does not work

| Problem | Try this |
| --- | --- |
| The app cannot find Chrome | Keep Chrome open and check that remote debugging is enabled on the page used during setup. Leave **Chrome endpoint** blank under **Connection settings**. |
| The app stays on Connecting | Look in Chrome for a connection approval dialog. You can also click **Stop**, then **Start captions** to retry. |
| Chrome disconnected | Reopen Chrome if needed, then click **Start captions** again. |
| No caption appears | Bring the page to the front and select ordinary page text. Text inside images, PDFs, text boxes, and editors is not supported. Chrome settings pages are also excluded. |
| Translation fails or times out | Check your internet connection. Clear the selection and select it again. Try a shorter passage; the limit is 10,000 characters. |
| The translation goes in the wrong direction | Check your two selected languages. Very short or mixed-language selections may be ambiguous; select a complete sentence for more context. |

If you were given a specific Chrome connection address, enter it under **Connection settings → Chrome endpoint**. Otherwise, leave that field blank.

The default translation server is in Tokyo. If your app provider asks you to change it, use **Connection settings → Translation server**. The hosted addresses are listed in the [main README](../README.md#desktop-captions-for-selected-text).

## Privacy

While captions are running, selected page text is sent to the translation server and processed by Google's Gemini service. Avoid selecting text you do not want to send for translation. The app does not send the entire page, record audio, or capture your screen.

The app saves your language and connection preferences locally, but does not save a translation history. Selections in text boxes and editable areas are excluded. Click **Stop** to disconnect from Chrome and stop translating selections.
