// Explicit opt-in smoke check against the deployed server; no API key is needed locally.
// Run: node test/live-smoke.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';
import { SelectionWatcher } from '../src/watcher.js';
import { DEFAULT_SERVER } from '../src/translation.js';

const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html><body style="font:24px system-ui;padding:60px;background:#f3f6fb"><h1>Live Translator — browser caption test</h1><p>Hello, thank you for your help.</p></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
let watcher;
try {
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.bringToFront();
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  let result;
  watcher = new SelectionWatcher(browser, { server: process.env.TRANSLATOR_SERVER || DEFAULT_SERVER, source: 'en', target: 'ja' }, update => {
    if (update.translation) result = update.translation;
  });
  watcher.start();
  for (let n = 0; n < 240 && !result; n++) await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(result, 'No translated caption returned within 60 seconds');
  assert.match(result, /[\u3040-\u30ff\u4e00-\u9fff]/);
  assert.equal(await page.$eval(`#${watcher.captionId}`, el => el.shadowRoot.querySelector('div').textContent), result);
  await page.screenshot({ path: '/tmp/live-translator-caption.png' });
  console.log(`PASS: selected browser text → deployed server → caption: ${result}`);
  await watcher.stop();
  assert.equal(await page.$(`#${watcher.captionId}`), null);
} finally {
  await watcher?.stop();
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
