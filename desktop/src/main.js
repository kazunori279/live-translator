import { app, BrowserWindow, ipcMain, session } from 'electron';
import { connectChrome } from './chrome.js';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_SERVER, loadLanguages, serverURL } from './translation.js';
import { SelectionWatcher } from './watcher.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
let window;
let browser;
let watcher;
let starting = false;
let connectionAbort;
let quitting = false;
let settings = { server: DEFAULT_SERVER, source: 'en', target: 'ja', endpoint: '' };
const report = data => { if (window && !window.isDestroyed()) window.webContents.send('status', data); };

function validateSettings(value) {
  const server = serverURL(value.server).href.replace(/\/$/, '');
  if (!/^[a-zA-Z0-9-]{2,20}$/.test(value.source) || !/^[a-zA-Z0-9-]{2,20}$/.test(value.target)) {
    throw new Error('Choose source and target languages.');
  }
  if (value.source === value.target) throw new Error('Choose two different languages.');
  const endpoint = String(value.endpoint || '').trim();
  if (endpoint) {
    const url = new URL(endpoint);
    if (!['http:', 'ws:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
      throw new Error('The Chrome connection must use HTTP or WS on localhost.');
    }
  }
  return { server, source: value.source, target: value.target, endpoint };
}

async function stop() {
  connectionAbort?.abort();
  const oldWatcher = watcher;
  const oldBrowser = browser;
  watcher = null;
  browser = null;
  await oldWatcher?.stop();
  // Disconnect only. Never close the user's browser or tabs.
  if (oldBrowser?.connected) await oldBrowser.disconnect();
  report({ running: false, message: 'Stopped. Chrome is still open.' });
}

function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Invalid application window.');
    }
    return fn(...args);
  });
}

app.whenReady().then(async () => {
try {
  settings = validateSettings(JSON.parse(await readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8')));
} catch { /* First run, or obsolete settings. */ }
session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
handle('settings', () => settings);
handle('openChromeSettings', async () => {
  if (process.platform !== 'darwin') {
    throw new Error('Open chrome://inspect/#remote-debugging in Chrome.');
  }
  try {
    await promisify(execFile)('/usr/bin/open', ['-a', 'Google Chrome', 'chrome://inspect/#remote-debugging']);
  } catch {
    throw new Error('Could not open Chrome. Open chrome://inspect/#remote-debugging in Chrome manually.');
  }
});
handle('languages', server => loadLanguages(server));
handle('start', async value => {
  if (starting) throw new Error('A connection is already in progress.');
  starting = true;
  try {
    await stop();
    const next = validateSettings(value);
    connectionAbort = new AbortController();
    const connectionSignal = connectionAbort.signal;
    const { languages } = await loadLanguages(next.server);
    if (connectionSignal.aborted) throw new DOMException('Connection cancelled', 'AbortError');
    if (!languages[next.source] || !languages[next.target]) throw new Error('Language is not supported by this server.');
    report({ message: 'Connecting to Chrome… Approve the connection in Chrome if prompted.' });
    browser = await connectChrome(next.endpoint, { signal: connectionSignal });
    connectionAbort = null;
    const connectedBrowser = browser;
    browser.on('disconnected', () => {
      if (browser !== connectedBrowser) return;
      const oldWatcher = watcher;
      browser = null;
      watcher = null;
      void oldWatcher?.stop();
      report({ running: false, message: 'Chrome disconnected. Click Start to reconnect.' });
    });
    settings = next;
    await writeFile(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(settings, null, 2));
    watcher = new SelectionWatcher(browser, settings, report);
    watcher.start();
    report({ running: true, message: 'Connected. Select text in the active Chrome tab.' });
  } catch (error) {
    await stop();
    if (error.name === 'AbortError') return;
    throw new Error(`Could not start: ${error.message}. Enable remote debugging at chrome://inspect/#remote-debugging.`);
  } finally { starting = false; connectionAbort = null; }
});
handle('stop', stop);
window = new BrowserWindow({
  width: 620, height: 720, minWidth: 480, minHeight: 600,
  title: 'Live Translator', backgroundColor: '#f5f6fa',
  webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
});
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', event => event.preventDefault());
await window.loadFile(path.join(directory, 'index.html'));
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void stop().finally(() => app.quit());
});

}).catch(error => { console.error(error); app.quit(); });
