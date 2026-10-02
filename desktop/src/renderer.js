const get = id => document.getElementById(id);
let running = false;
let busy = false;
let connecting = false;
function controls() {
  get('options').disabled = running || busy;
  get('start').disabled = running || busy;
  get('stop').disabled = !connecting && (!running || busy);
  get('badge').textContent = running ? 'Running' : busy ? 'Connecting' : 'Stopped';
  get('badge').classList.toggle('running', running);
}
function values() {
  return Object.fromEntries(['server', 'source', 'target', 'endpoint'].map(key => [key, get(key).value]));
}
async function languages(source = get('source').value, target = get('target').value) {
  const entries = Object.entries(await window.translator.languages(get('server').value));
  for (const [id, selected] of [['source', source], ['target', target]]) {
    get(id).replaceChildren(...entries.map(([code, name]) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = name;
      return option;
    }));
    get(id).value = selected;
  }
}
window.translator.onStatus(data => {
  if (data.running !== undefined) running = data.running;
  if (data.message !== undefined) get('status').textContent = data.message;
  if (data.selection !== undefined) get('original').textContent = data.selection;
  if (data.translation !== undefined) get('translation').textContent = data.translation || 'Waiting for a translation…';
  controls();
});
get('settingsForm').addEventListener('submit', async event => {
  event.preventDefault();
  connecting = true;
  busy = true;
  controls();
  get('status').textContent = 'Connecting…';
  try { await window.translator.start(values()); }
  catch (error) { get('status').textContent = error.message; }
  finally { busy = false; connecting = false; controls(); }
});
get('stop').addEventListener('click', async () => {
  busy = true;
  controls();
  try { await window.translator.stop(); }
  catch (error) { get('status').textContent = error.message; }
  finally { busy = false; controls(); }
});
get('reloadLanguages').addEventListener('click', async () => {
  try { await languages(); get('status').textContent = 'Languages updated.'; }
  catch (error) { get('status').textContent = error.message; }
});
(async () => {
  busy = true;
  controls();
  try {
    const settings = await window.translator.settings();
    for (const key of ['server', 'endpoint']) get(key).value = settings[key];
    await languages(settings.source, settings.target);
    get('status').textContent = 'Ready. Enable remote debugging in Chrome, then click Start.';
  } catch (error) { get('status').textContent = error.message; }
  finally { busy = false; controls(); }
})();
