import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('distributed manifest requests optional site access and Start refuses missing permission', async () => {
  const manifest = JSON.parse(await readFile(new URL('../dist/live-translator-chrome/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.permissions, ['storage', 'scripting']);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.equal(manifest.host_permissions.some(origin => origin.includes('*://') || origin.includes('://*')), false);
  let listener;
  let fetches = 0;
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { getURL: file => `chrome-extension://test/${file}`, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: { async get() { return {}; } }, session: { async get() { return {}; } } },
    permissions: { async contains() { return false; }, onRemoved: event() },
    tabs: { onActivated: event(), onRemoved: event(), onUpdated: event() },
    windows: { onFocusChanged: event() },
  };
  const code = await readFile(new URL('../dist/live-translator-chrome/background.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { chrome, URL, AbortSignal, fetch: () => { fetches++; throw new Error('Unexpected request'); } });
  const result = await new Promise(resolve => listener({ type: 'start', settings: {} }, { url: chrome.runtime.getURL('popup.html') }, resolve));
  assert.equal(result.ok, false);
  assert.match(result.error, /Allow website access/);
  assert.equal(fetches, 0);
  // A page content script cannot enable translation or set a server URL.
  assert.equal(listener({ type: 'start', settings: {} }, { url: 'https://example.com', tab: { id: 1 } }, () => assert.fail('Page controlled extension settings')), undefined);
});
