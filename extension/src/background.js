import { DEFAULT_SERVER, loadLanguages, serverURL, translate } from '../../desktop/src/translation.js';

const ORIGINS = ['http://*/*', 'https://*/*'];
const defaults = { server: DEFAULT_SERVER, source: 'en', target: 'ja' };
let state;
let current;
const ready = Promise.all([chrome.storage.local.get('settings'), chrome.storage.session.get(['enabled', 'preview'])])
  .then(([local, session]) => state = {
    settings: { ...defaults, ...local.settings }, enabled: session.enabled === true,
    preview: session.preview || { message: 'Ready. Choose two languages, then start captions.' },
  });

async function report(preview) {
  state.preview = preview;
  await chrome.storage.session.set({ preview });
}
async function send(tabId, message, options) {
  try { return await chrome.tabs.sendMessage(tabId, message, options); }
  catch { /* Restricted pages, removed frames, or tabs without our content script. */ }
}
async function caption(tabId, text, error = false, persistent = false) {
  await send(tabId, { type: 'caption', text, error, persistent }, { frameId: 0 });
}
async function isActive(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const window = await chrome.windows.get(tab.windowId);
    return tab.active && window.focused && !tab.discarded;
  } catch { return false; }
}
async function cancel() {
  const old = current;
  current = null;
  old?.abort.abort();
  if (old) await caption(old.tabId, '');
}
async function broadcast(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => send(tab.id, message)));
}
async function focusChanged() {
  await ready;
  await cancel();
  await broadcast({ type: 'clearCaption' });
  if (!state.enabled) return;
  await report({ message: 'Select text in the active Chrome tab.' });
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  for (const tab of tabs) if (await isActive(tab.id)) await send(tab.id, { type: 'scan', enabled: true });
}

async function pageConnection(repair = false) {
  await ready;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { connected: false, message: 'No active Chrome tab.' };
  if (tab.url && !/^https?:\/\//.test(tab.url)) {
    return { connected: false, message: 'This page is unsupported. Open a regular web page.' };
  }
  if (repair) {
    if (!state.enabled) throw new Error('Start captions before reconnecting the page.');
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content.js'], injectImmediately: true });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'], injectImmediately: true }).catch(() => {});
      await send(tab.id, { type: 'enabled', enabled: true });
    } catch {
      throw new Error('Cannot access this page. Check Chrome’s site access for Text Live Translator, then refresh the page.');
    }
  }
  const reply = await send(tab.id, { type: 'ping' }, { frameId: 0 });
  if (!reply?.connected) return { connected: false, message: 'Page not connected. Click Reconnect page. If it fails, check Chrome’s site access for this website.' };
  if (!reply.enabled && state.enabled) {
    await send(tab.id, { type: 'enabled', enabled: true });
  }
  return { connected: true, message: state.enabled ? 'Page connected. Select ordinary page text to translate.' : 'Page connected. Start captions to translate.' };
}

async function select(message, sender) {
  await ready;
  if (!state.enabled || !await isActive(sender.tab.id) || !state.enabled) return;
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text || typeof message.token !== 'string') return;
  await cancel();
  if (!state.enabled) return;
  const job = { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId,
    token: message.token, abort: new AbortController() };
  current = job;
  const valid = async () => current === job && state.enabled && await isActive(job.tabId) && current === job;
  if (text.length > 10000) {
    await caption(job.tabId, 'Select up to 10,000 characters.', true);
    await report({ message: 'Selection is too long (maximum 10,000 characters).' });
    return;
  }
  const selected = await send(job.tabId, { type: 'check', token: job.token },
    job.documentId ? { documentId: job.documentId } : { frameId: job.frameId });
  if (!selected?.selected || !await valid()) return;
  await caption(job.tabId, 'Translating…');
  await report({ message: 'Translating selected text…', original: text });
  try {
    if (!await valid()) return;
    const result = await translate({ ...state.settings, text, signal: job.abort.signal, timeoutMs: 25000 });
    if (!await valid()) return;
    // Verify in the originating document too: navigations may reuse a frame ID.
    const stillSelected = await send(job.tabId, { type: 'check', token: job.token },
      job.documentId ? { documentId: job.documentId } : { frameId: job.frameId });
    if (!stillSelected?.selected || !await valid()) return;
    await caption(job.tabId, result, false, true);
    await report({ message: 'Caption displayed. Select another passage to translate.', original: text, translation: result });
  } catch (error) {
    if (error.name === 'AbortError' || !await valid()) return;
    await caption(job.tabId, error.message, true);
    await report({ message: error.message });
  }
}

async function start(settings) {
  await ready;
  if (!await chrome.permissions.contains({ origins: ORIGINS })) throw new Error('Allow website access to follow your selected text across tabs.');
  const server = serverURL(settings.server).href.replace(/\/$/, '');
  const { languages } = await loadLanguages(server);
  if (!languages[settings.source] || !languages[settings.target] || settings.source === settings.target) {
    throw new Error('Choose two different supported languages.');
  }
  await cancel();
  state.settings = { server, source: settings.source, target: settings.target };
  await chrome.storage.local.set({ settings: state.settings });
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['captions'] });
  if (!scripts.length) {
    await chrome.scripting.registerContentScripts([{
      id: 'captions', matches: ORIGINS, js: ['content.js'], allFrames: true,
      runAt: 'document_start', persistAcrossSessions: false,
    }]);
  }
  state.enabled = true;
  await chrome.storage.session.set({ enabled: true });
  await chrome.action.setBadgeText({ text: 'ON' });
  await chrome.action.setBadgeBackgroundColor({ color: '#386ae8' });
  // Register handles future tabs/navigations; inject handles already-open pages.
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true }, files: ['content.js'], injectImmediately: true,
  }).catch(() => {})));
  await broadcast({ type: 'enabled', enabled: true });
  await focusChanged();
  return state;
}
async function stop() {
  await ready;
  state.enabled = false;
  await chrome.storage.session.set({ enabled: false });
  await cancel();
  await chrome.scripting.unregisterContentScripts({ ids: ['captions'] }).catch(() => {});
  await broadcast({ type: 'enabled', enabled: false });
  await chrome.action.setBadgeText({ text: '' });
  await report({ message: 'Stopped. Select Start captions to resume.' });
  return state;
}

// Serialize Start/Stop so a late language request cannot undo a user's Stop.
let controls = Promise.resolve();
function control(fn) {
  const result = controls.then(fn);
  controls = result.catch(() => {});
  return result;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const ui = sender.url === chrome.runtime.getURL('popup.html');
  const content = sender.tab && /^https?:\/\//.test(sender.url || '');
  let task;
  if (ui) {
    if (message.type === 'page') task = pageConnection();
    if (message.type === 'reconnect') task = pageConnection(true);
    if (message.type === 'state') task = ready.then(() => state);
    if (message.type === 'languages') task = loadLanguages(message.server);
    if (message.type === 'start') task = control(() => start(message.settings));
    if (message.type === 'stop') task = control(stop);
  } else if (content) {
    if (message.type === 'hello') task = ready.then(() => ({ enabled: state.enabled }));
    if (message.type === 'selection') task = select(message, sender);
    if (message.type === 'clear') task = ready.then(async () => {
      if (!current && state.enabled && await isActive(sender.tab.id) && !current) {
        await caption(sender.tab.id, '');
      }
      if (current?.tabId === sender.tab.id && current.frameId === sender.frameId && current.token === message.token) {
        await cancel();
        await report({ message: 'Select text in the active Chrome tab.' });
      }
    });
  }
  if (!task) return;
  Promise.resolve(task).then(value => respond({ ok: true, value }), error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.tabs.onActivated.addListener(() => { void focusChanged(); });
chrome.windows.onFocusChanged.addListener(() => { void focusChanged(); });
chrome.tabs.onRemoved.addListener(tabId => { if (current?.tabId === tabId) void cancel(); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && current?.tabId === tabId) void cancel();
});
chrome.permissions.onRemoved.addListener(() => {
  void chrome.permissions.contains({ origins: ORIGINS }).then(allowed => { if (!allowed) return control(stop); });
});
