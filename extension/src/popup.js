import { languageGroups, languagePair } from '../../desktop/src/languages.js';
import { DEFAULT_SERVER, serverURL } from '../../desktop/src/translation.js';
const get = id => document.getElementById(id);
let running = false;
let busy = true;
let previousPair = { source: 'en', target: 'ja' };
async function send(type, rest = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...rest });
  if (!response?.ok) throw new Error(response?.error || 'Could not contact the extension. Try reopening it.');
  return response.value;
}
function controls() {
  get('options').disabled = running || busy;
  get('start').disabled = running || busy;
  get('stop').disabled = !running || busy;
  get('badge').textContent = running ? 'Running' : busy ? 'Loading' : 'Stopped';
  get('badge').classList.toggle('running', running);
}
function preview(data) {
  get('status').textContent = data.message || '';
  get('original').textContent = data.original || '';
  get('translation').textContent = data.translation || 'Your translated selection will appear here and on the page.';
}
async function languages(source = get('source').value, target = get('target').value) {
  const catalog = await send('languages', { server: get('server').value });
  const groups = languageGroups(catalog.languages, catalog.popular);
  const pair = languagePair(catalog.languages, source, target);
  for (const id of ['source', 'target']) {
    get(id).replaceChildren(...groups.map(({ label, codes }) => {
      const group = document.createElement('optgroup');
      group.label = label;
      group.append(...codes.map(code => {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = catalog.languages[code];
        return option;
      }));
      return group;
    }));
    get(id).value = pair[id];
  }
  previousPair = pair;
}
for (const id of ['source', 'target']) {
  get(id).addEventListener('change', () => {
    if (get('source').value === get('target').value) get(id === 'source' ? 'target' : 'source').value = previousPair[id];
    previousPair = { source: get('source').value, target: get('target').value };
  });
}
get('settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  // The permission request must be made directly inside this user gesture.
  const permission = chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
  busy = true;
  controls();
  try {
    if (!await permission) throw new Error('Website access was not allowed. Click Start captions to try again.');
    const settings = Object.fromEntries(['server', 'source', 'target'].map(id => [id, get(id).value]));
    const state = await send('start', { settings });
    running = state.enabled;
    preview(state.preview);
  } catch (error) { get('status').textContent = error.message; }
  finally { busy = false; controls(); }
});
get('stop').addEventListener('click', async () => {
  busy = true;
  controls();
  try { const state = await send('stop'); running = state.enabled; preview(state.preview); }
  catch (error) { get('status').textContent = error.message; }
  finally { busy = false; controls(); }
});
get('reload').addEventListener('click', async () => {
  try {
    const url = serverURL(get('server').value);
    const permission = chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
    if (!await permission) throw new Error('Allow access to this translation server to load its languages.');
    await languages();
    get('status').textContent = 'Languages updated.';
  } catch (error) { get('status').textContent = error.message; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.enabled) { running = changes.enabled.newValue === true; controls(); }
  if (changes.preview) preview(changes.preview.newValue || {});
});
controls();
get('server').value = DEFAULT_SERVER;
try {
  const state = await send('state');
  running = state.enabled;
  get('server').value = state.settings.server;
  await languages(state.settings.source, state.settings.target);
  preview(state.preview);
} catch (error) { get('status').textContent = error.message; }
finally { busy = false; controls(); }
