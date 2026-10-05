# Text Live Translator for Chrome

Select text on a web page and see a translation as a caption on that page. Choose two languages and translate in either direction, without changing settings each time.

This extension uses the same translation service as the desktop app. You do not need the desktop app, remote debugging, a Gemini API key, or any developer software.

## Install

1. [Download the Chrome extension ZIP](https://github.com/kazunori279/live-translator/releases/download/chrome-v0.1.3/Text-Live-Translator-Chrome.zip).
2. Unzip it and keep the **live-translator-chrome** folder somewhere permanent. You do not need to download this repository.
3. In Chrome on your computer, open `chrome://extensions`.
4. Turn on **Developer mode**, click **Load unpacked**, and select the **live-translator-chrome** folder containing `manifest.json`.
5. Open Chrome’s **Extensions** menu (the puzzle piece) and pin **Text Live Translator** to the toolbar.

The extension is distributed as a ZIP and is not currently listed in the Chrome Web Store. Chrome’s Developer mode is needed to load this local extension; you do not need to enable remote debugging. Chrome 120 or later is required. Chrome on phones is not supported.

## Start translating

1. Click the Text Live Translator toolbar icon.
2. Choose **Language 1** and **Language 2**. The ten popular languages appear first in each menu; the other languages follow alphabetically.
3. Click **Start captions**. If Chrome asks for permission to read and change data on websites, allow it if you want captions to follow you across tabs. This access lets the extension read your selected text and add captions to the page. It is a site-access permission, not a remote debugging connection.
4. Close the popup, open a regular web page, and select a sentence or paragraph. Pause briefly; the translation appears near the bottom of the page.
5. Select another passage, switch tabs, or open a new tab to continue. There is no need to restart captions for each tab.

With **English ⇄ Japanese** selected, English becomes Japanese and Japanese becomes English. Other languages translate into **Language 2**. Text inside a text box or editor is excluded, and selections are limited to 10,000 characters.

The toolbar badge shows **ON** while captions are running. Closing the popup keeps translation running. To finish, open the popup and click **Stop**; this stops translation requests and removes captions. To change languages, stop captions, choose a new pair, and start again.

Your language and server preferences are saved. After restarting Chrome, click **Start captions** again. If you have also been using the desktop app, stop its captions to avoid duplicate overlays.

## Captions stay on each tab

Completed translations stay on their original tab automatically, even when you clear the selection or switch tabs. Select another passage on that tab to replace its caption; other tabs keep their own captions.

Click **Stop** to remove all captions. Navigating, reloading, or closing a page removes its caption. Captions are not saved between page loads.

If you share a Chrome tab, its translation remains there while you work in another tab. Captions do not follow you onto other tabs or open a separate window.

## Connection settings

The default translation server is in Tokyo. Leave it unchanged for normal use. To use another server, open **Connection settings**, enter its address, and click **Reload languages**. Chrome may ask for permission to access that server.

| Server | Address |
| --- | --- |
| Tokyo (default) | `https://live-translation-761793285222.asia-northeast1.run.app` |
| US Central | `https://live-translation-761793285222.us-central1.run.app` |

## Troubleshooting

| Problem | What to try |
| --- | --- |
| Chrome asks for website access | Click **Allow** after **Start captions** to enable captions across websites. If you deny the request, captions stay stopped. |
| Nothing happens on a page | With captions running, open the popup on that page and check the connection message. Click **Reconnect page** to attach again. If access is denied, check Chrome’s site access setting for Text Live Translator. Refresh the page after updating the extension. |
| A page is unsupported | Chrome settings pages, the Chrome Web Store, the built-in PDF viewer, text in images, and editable fields are not supported. Try an ordinary HTTP/HTTPS page. |
| Translation fails | Check your internet connection, then clear and reselect the text. Try a shorter passage. |
| The translation goes in the wrong direction | Check the selected language pair. Very short or mixed-language passages may be ambiguous; select a full sentence. |
| Captions stopped after restarting Chrome | Open the extension and click **Start captions** again. |
| A managed browser blocks installation | Your organization may restrict unpacked extensions. Ask its administrator whether installation is allowed. |

On a company-managed Mac, check `chrome://policy` for **ExtensionSettings**, especially **runtime_blocked_hosts**. An administrator can prevent extensions from running on specific websites even when those websites open normally. Company network controls can also block access to the translation server. Ask your administrator to confirm the permitted sites and server access; reconnecting cannot override these policies. [Chrome Enterprise policy documentation](https://support.google.com/chrome/a/answer/9867568).

To update an unpacked installation, stop captions, replace the contents of the installed extension folder with the new download, and click the extension’s **Reload** button on `chrome://extensions`. Refresh open web pages before starting captions again.

## Privacy

While captions are running, the extension sends selected text from the active tab to your configured translation server, which processes it using Google’s Gemini service. It does not send entire pages, record audio, or capture your screen. Only select text you want to send for translation.

Language and connection preferences are saved locally. The latest selected text and translation are held temporarily in Chrome’s session storage for the popup preview; they are cleared when you stop captions or close Chrome. No translation history is saved to disk by the extension.

Website access remains granted after **Stop**, but the extension stops monitoring selections for translation. You can revoke site access or remove the extension from `chrome://extensions`.

[Developer build and test instructions](DEVELOPMENT.md)
