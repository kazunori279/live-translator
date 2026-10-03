import { showCaption } from '../../desktop/src/page.js';

// Start may inject into an already registered page. Never add duplicate listeners.
if (!globalThis.__liveTranslatorExtension) {
  globalThis.__liveTranslatorExtension = true;
  const captionId = `live-translator-extension-${chrome.runtime.id}`;
  let enabled = false;
  let token = '';
  let selectedText = '';
  let timer;
  let revision = 0;
  async function message(value) {
    try { return await chrome.runtime.sendMessage(value); }
    catch { disable(); }
  }
  function read() {
    if (document.visibilityState !== 'visible') return '';
    if (window !== window.top && !document.hasFocus()) return '';
    const active = document.activeElement;
    if (active?.matches('input,textarea,iframe,frame') || active?.isContentEditable) return '';
    const selection = getSelection();
    const parent = selection?.anchorNode?.parentElement;
    if (parent?.closest('input,textarea,[contenteditable]:not([contenteditable="false"])')) return '';
    return selection?.toString().trim() || '';
  }
  function clear() {
    clearTimeout(timer);
    if (token) void message({ type: 'clear', token });
    token = '';
    selectedText = '';
    if (window === window.top) showCaption(captionId, '');
  }
  function disable() {
    enabled = false;
    clearTimeout(timer);
    token = '';
    selectedText = '';
    showCaption(captionId, '');
  }
  function scan(force = false) {
    if (!enabled) return;
    const text = read();
    if (!force && text === selectedText) return;
    clear();
    if (!text) return;
    selectedText = text;
    token = crypto.randomUUID();
    const next = token;
    timer = setTimeout(() => {
      if (enabled && token === next && read() === text) {
        void message({ type: 'selection', text, token });
      }
    }, 600);
  }
  document.addEventListener('selectionchange', () => scan());
  document.addEventListener('focusin', () => scan());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') clear();
    else scan(true);
  });
  window.addEventListener('pagehide', clear);
  chrome.runtime.onMessage.addListener((request, _sender, respond) => {
    if (request.type === 'enabled') {
      revision++;
      if (!request.enabled) disable();
      else { enabled = true; scan(true); }
    }
    if (request.type === 'scan') scan(true);
    if (request.type === 'clearCaption') { clear(); }
    if (request.type === 'caption' && window === window.top) {
      if (enabled || request.text === '') showCaption(captionId, request.text, request.error);
    }
    if (request.type === 'check') {
      respond({ selected: enabled && token === request.token && !!selectedText && read() === selectedText });
    }
  });
  // Captions expire if extension execution is interrupted or the extension is removed.
  setInterval(() => {
    if (!chrome.runtime.id) { disable(); return; }
    if (enabled && document.getElementById(captionId)) showCaption(captionId, null);
  }, 2000);
  const initialRevision = revision;
  void message({ type: 'hello' }).then(reply => {
    if (initialRevision !== revision) return;
    enabled = reply?.value?.enabled === true;
    if (enabled) scan(true);
  });
}
