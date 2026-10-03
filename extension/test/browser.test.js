import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
  for (let n = 0; n < 100; n++) { if (await fn()) return; await wait(100); }
  assert.fail(message);
}
async function select(page, selector = 'p') {
  await page.evaluate(selector => {
    const element = document.querySelector(selector);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  }, selector);
}
async function caption(page) {
  return page.evaluate(() => [...document.querySelectorAll('[id^="live-translator-extension-"]')]
    .map(host => host.shadowRoot?.querySelector('div')?.textContent).join(''));
}

test('MV3: popup, selections, two-way requests, new tabs, frames, cancellation, worker restart and Stop', { timeout: 90000 }, async t => {
  const requests = [];
  let slowResponse;
  const languages = { en: 'English', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', ko: 'Korean', hi: 'Hindi', ar: 'Arabic', it: 'Italian' };
  const server = createServer(async (req, res) => {
    if (req.url === '/api/languages') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ languages, popular: Object.keys(languages).slice(0, 10) }));
    }
    if (req.url === '/api/translate') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      res.setHeader('Content-Type', 'application/json');
      if (body.text === 'Slow selection') { slowResponse = res; return; }
      return res.end(JSON.stringify({ text: body.text === 'こんにちは' ? 'Hello' : `訳: ${body.text}` }));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const blocker = req.url === '/blocked' ? '<script>window.addEventListener("selectionchange", e => e.stopImmediatePropagation(), true)</script>' : '';
    res.end(blocker + '<!doctype html><p>Hello world</p><h1>こんにちは</h1><h2>Slow selection</h2><h3>&lt;img src=x onerror=alert(1)&gt;</h3><input value="private text"><div contenteditable>Private draft</div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const directory = await mkdtemp(path.join(tmpdir(), 'translator-extension-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../dist/live-translator-chrome/', import.meta.url), directory, { recursive: true });
  // Only this disposable test build grants hosts at install time, avoiding a
  // native permission prompt in headless Chrome. The distributed build asks on Start.
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['http://*/*', 'https://*/*'];
  await writeFile(manifestPath, JSON.stringify(manifest));
  for (const file of ['background.js', 'popup.js']) {
    const location = path.join(directory, file);
    await writeFile(location, (await readFile(location, 'utf8')).replaceAll('https://live-translation-761793285222.asia-northeast1.run.app', url));
  }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, pipe: true, enableExtensions: true, args: ['--enable-unsafe-extension-debugging'],
  });
  t.after(() => browser.close());
  const id = await browser.installExtension(directory);
  const popup = await browser.newPage();
  await popup.setViewport({ width: 420, height: 700 });
  const errors = [];
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => !document.getElementById('start').disabled);
  assert.equal(await popup.$$eval('#source optgroup:first-child option', options => options.length), 10);
  assert.equal(await popup.$eval('#source', select => select.value), 'en');
  await popup.screenshot({ path: '/tmp/live-translator-extension-popup.png', fullPage: true });
  await popup.click('#start');
  await popup.waitForFunction(() => document.getElementById('badge').textContent === 'Running');
  // Keep the popup's tab open as a control surface, but select text on another tab.
  const page = await browser.newPage();
  await page.goto(url); await page.bringToFront();
  await select(page);
  await until(async () => (await caption(page)) === '訳: Hello world', 'first caption missing');
  assert.equal(requests[0].bidirectional, true);
  const connection = await popup.evaluate(() => chrome.runtime.sendMessage({type: 'page'}));
  assert.equal(connection.value.connected, true);
  const recovered = await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
    await chrome.tabs.sendMessage(tab.id, {type: 'enabled', enabled: false});
    return chrome.runtime.sendMessage({type: 'reconnect'});
  });
  assert.equal(recovered.value.connected, true);
  await until(async () => (await caption(page)) === '訳: Hello world', 'reconnect did not restore captions');
  await select(page, 'h1');
  await until(async () => (await caption(page)) === 'Hello', 'reverse direction caption missing');
  await page.focus('input'); await wait(800);
  const count = requests.length;
  await page.focus('[contenteditable]'); await select(page, '[contenteditable]'); await wait(900);
  assert.equal(requests.length, count, 'editor contents were sent');
  await page.evaluate(() => document.activeElement.blur());
  await select(page, 'h3');
  await until(async () => (await caption(page)).includes('<img'), 'literal caption missing');
  assert.equal(await page.evaluate(() => document.querySelector('[id^="live-translator-extension-"]').shadowRoot.querySelector('img')), null);
  await select(page, 'h2');
  await until(() => !!slowResponse, 'slow translation did not start');
  await page.evaluate(() => getSelection().removeAllRanges());
  await until(async () => !await caption(page), 'cleared selection left a caption');
  slowResponse.end(JSON.stringify({ text: 'STALE CAPTION' }));
  await wait(300); assert.equal(await caption(page), '');
  const second = await browser.newPage();
  await second.goto(url); await second.bringToFront(); await select(second);
  await until(async () => (await caption(second)) === '訳: Hello world', 'new tab was not translated');
  assert.equal(await caption(page), '');
  await second.goto(`${url}/blocked`); await select(second, 'h1');
  await until(async () => (await caption(second)) === 'Hello', 'site consumed selection event without fallback');
  await second.evaluate(() => getSelection().removeAllRanges());
  await until(async () => !await caption(second), 'selection clear was missed when site consumed events');
  await page.bringToFront(); await select(page);
  await until(async () => (await caption(page)) === '訳: Hello world', 'return to old tab failed');
  await until(async () => !await caption(second), 'caption remained on old tab');
  await page.evaluate(url => {
    const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame);
  }, url.replace('127.0.0.1', 'localhost'));
  await until(() => page.frames().length === 2, 'iframe missing');
  const frame = page.frames()[1]; await frame.waitForSelector('h1');
  await frame.evaluate(() => window.focus()); await select(frame, 'h1');
  await until(async () => (await caption(page)) === 'Hello', 'cross-origin iframe failed');
  await page.reload(); await select(page);
  await until(async () => (await caption(page)) === '訳: Hello world', 'navigation lost captions');
  // Simulate an idle MV3 worker being torn down, preserving only Chrome storage.
  const cdp = await browser.target().createCDPSession();
  const worker = browser.targets().find(target => target.type() === 'service_worker' && target.url().includes(id));
  await cdp.send('Target.closeTarget', { targetId: worker._targetId });
  await wait(200);
  await select(page, 'h1');
  await until(async () => (await caption(page)) === 'Hello', 'worker restart lost settings/running state');
  await popup.bringToFront();
  await popup.click('#stop');
  await popup.waitForFunction(() => document.getElementById('badge').textContent === 'Stopped');
  await page.bringToFront(); await select(page);
  const stoppedCount = requests.length; await wait(1000);
  assert.equal(requests.length, stoppedCount, 'Stop still sent text');
  assert.equal(await caption(page), '');
  assert.equal(await caption(second), '');
  if (process.env.LIVE_TRANSLATION === '1') {
    await popup.bringToFront();
    const started = await popup.evaluate(async () => chrome.runtime.sendMessage({ type: 'start', settings: {
      server: 'https://live-translation-761793285222.asia-northeast1.run.app', source: 'en', target: 'ja',
    } }));
    assert.equal(started.ok, true);
    await page.bringToFront(); await select(page);
    await until(async () => /[ぁ-んァ-ヶ]/.test(await caption(page)), 'live server caption missing');
    t.diagnostic(`Live Gemini caption: ${await caption(page)}`);
    await popup.evaluate(() => chrome.runtime.sendMessage({type: 'stop'}));
  }
  assert.deepEqual(errors, []);
});
