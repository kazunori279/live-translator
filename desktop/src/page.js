// These functions run in the target frame, without access to Node or Electron.
export function readSelection(key) {
  const focused = document.hasFocus() && document.visibilityState === 'visible';
  if (!focused) return { focused: false };
  const active = document.activeElement;
  // Translate document text only, never typing in password, input, or editor fields.
  if (active?.matches('input, textarea, iframe, frame') || active?.isContentEditable) {
    return { focused: true, text: '' };
  }
  const selection = window.getSelection();
  const parent = selection?.anchorNode?.parentElement;
  const text = parent?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')
    ? '' : (selection?.toString() || '').trim();
  if (!globalThis[key]) {
    globalThis[key] = { documentId: `${Date.now()}-${Math.random()}` };
  }
  return { focused: true, text, documentId: globalThis[key].documentId, url: location.href };
}

export function showCaption(id, text, error = false, persistent = false, force = false) {
  let host = document.getElementById(id);
  const timerKey = `${id}_expiry`;
  if (text === '' && host?.dataset.persistent === 'true' && !force) return;
  clearTimeout(globalThis[timerKey]);
  delete globalThis[timerKey];
  if (text === '') { host?.remove(); return; }
  if (text === null && !host) return;
  if (!host) {
    host = document.createElement('div');
    host.id = id;
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:auto 20px 32px!important;width:fit-content!important;max-width:calc(100vw - 40px)!important;margin:0 auto!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;pointer-events:none!important;z-index:2147483647!important;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{color-scheme:dark}div{box-sizing:border-box;max-width:980px;max-height:36vh;overflow:auto;padding:14px 24px;border:1px solid #ffffff25;border-radius:14px;background:rgba(18,22,30,.94);box-shadow:0 8px 36px #0005;color:white;font:500 clamp(18px,2.3vw,30px)/1.5 system-ui,sans-serif;text-align:center;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:auto;user-select:none}div.error{color:#ffd1cf}';
    const label = document.createElement('div');
    label.setAttribute('role', 'status');
    label.setAttribute('aria-live', 'polite');
    shadow.append(style, label);
    window.addEventListener('pagehide', () => host.remove(), { once: true });
    (document.fullscreenElement || document.documentElement).append(host);
  }
  const label = host.shadowRoot.querySelector('div');
  if (text !== null) {
    label.textContent = text;
    label.className = error ? 'error' : '';
    host.dataset.persistent = String(persistent && !error);
  }
  // Top layer makes the caption visible above site dialogs and fullscreen content.
  try { if (!host.matches(':popover-open')) host.showPopover(); } catch { /* Older Chrome. */ }
  if (host.dataset.persistent === 'true') return;
  // Temporary status messages are renewed while the app is connected. A crash or lost CDP connection must not
  // leave an orphan caption on the user's page indefinitely.
  globalThis[timerKey] = setTimeout(() => {
    host.remove();
    delete globalThis[timerKey];
  }, 10000);
}

export function cleanPage(id, key) {
  document.getElementById(id)?.remove();
  clearTimeout(globalThis[`${id}_expiry`]);
  delete globalThis[`${id}_expiry`];
  delete globalThis[key];
}
