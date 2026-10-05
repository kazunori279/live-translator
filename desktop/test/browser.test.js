import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { SelectionWatcher } from '../src/watcher.js';
import { readSelection, showCaption } from '../src/page.js';
import { connectChrome } from '../src/chrome.js';

const executablePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) {
  for (let n = 0; n < 80; n++) {
    if (await fn()) return;
    await wait(100);
  }
  assert.fail(message);
}
async function select(page, selector = 'p') {
  await page.evaluate(selector => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(selector));
    const selected = window.getSelection();
    selected.removeAllRanges();
    selected.addRange(range);
  }, selector);
}

test('real Chrome: selection, iframe, safe caption, cancellation, tab changes, cleanup', {
  skip: !existsSync(executablePath), timeout: 30000,
}, async t => {
  const server = createServer((_req, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><body><p>Hello world</p><h1>Second selection</h1><input type="password" value="secret"><div contenteditable="true">Private draft</div></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const browser = await puppeteer.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const connection = await connectChrome(browser.wsEndpoint());
  t.after(() => connection.disconnect());
  const page = await browser.newPage();
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.goto(url);
  await page.bringToFront();
  await select(page);
  const reading = await page.mainFrame().isolatedRealm().evaluate(readSelection, 'testState');
  assert.equal(reading.text, 'Hello world');
  assert.equal(reading.focused, true);
  await page.mainFrame().isolatedRealm().evaluate(showCaption, 'testCaption', '<img src=x onerror=alert(1)>');
  assert.equal(await page.$eval('#testCaption', host => host.shadowRoot.querySelector('img')), null);
  assert.equal(await page.$eval('#testCaption', host => host.shadowRoot.querySelector('div').textContent), '<img src=x onerror=alert(1)>');
  await page.mainFrame().isolatedRealm().evaluate(showCaption, 'testCaption', '');
  await page.focus('input');
  assert.equal((await page.mainFrame().isolatedRealm().evaluate(readSelection, 'testState')).text, '');
  await page.focus('[contenteditable]');
  await select(page, '[contenteditable]');
  assert.equal((await page.mainFrame().isolatedRealm().evaluate(readSelection, 'testState')).text, '');
  await page.evaluate(() => document.activeElement.blur());
  await select(page);

  const jobs = [];
  const watcher = new SelectionWatcher(connection, {}, () => {}, args => new Promise(resolve => jobs.push({ ...args, resolve })));
  t.after(() => watcher.stop());
  watcher.start();
  await until(() => jobs.length === 1, 'first selection was not translated');
  const first = jobs[0];
  await select(page, 'h1');
  await until(() => first.signal.aborted, 'old translation was not cancelled');
  first.resolve('STALE CAPTION');
  await until(() => jobs.length === 2, 'new selection was not translated');
  jobs[1].resolve('新しい字幕');
  await until(async () => await page.evaluate(id => document.getElementById(id)?.shadowRoot.textContent.includes('新しい字幕'), watcher.captionId), 'caption missing');
  assert.equal(await page.evaluate(id => document.getElementById(id)?.shadowRoot.textContent.includes('STALE CAPTION'), watcher.captionId), false);

  // Other debugging clients can make every renderer report focus/visibility.
  // The watcher must use the actual Chrome tab strip instead of the first page.
  await page.emulateFocusedPage(true);
  const second = await browser.newPage();
  await second.emulateFocusedPage(true);
  await second.goto(url);
  await second.bringToFront();
  await select(second);
  assert.equal((await page.mainFrame().isolatedRealm().evaluate(readSelection, 'testState')).focused, true);
  assert.equal(await page.evaluate(id => document.getElementById(id)?.shadowRoot.querySelector('div').textContent, watcher.captionId), '新しい字幕');
  await until(() => jobs.length === 3, 'active tab did not follow');
  jobs[2].resolve('別のタブ');
  await until(async () => !!await second.$(`#${watcher.captionId}`), 'second tab caption missing');
  await second.evaluate(url => {
    const iframe = document.createElement('iframe');
    iframe.src = url;
    document.body.append(iframe);
  }, url.replace('127.0.0.1', 'localhost'));
  await until(() => second.frames().length === 2 && second.frames()[1].url().startsWith('http:'), 'iframe did not load');
  const frame = second.frames()[1];
  await frame.waitForSelector('p');
  await frame.evaluate(() => {
    window.focus();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await until(() => jobs.length === 4, 'cross-origin frame selection was not translated');
  assert.equal(jobs[3].text, 'Hello world');
  await second.reload();
  await until(() => jobs[3].signal.aborted, 'navigation did not cancel the request');
  jobs[3].resolve('STALE FRAME');
  await wait(350);
  assert.equal(await second.$(`#${watcher.captionId}`), null);
  await page.bringToFront();
  await select(page);
  await until(() => jobs.length === 5, 'returning to an existing tab was not detected');
  jobs[4].resolve('戻ったタブ');
  await until(async () => await page.evaluate(id => document.getElementById(id)?.shadowRoot.textContent.includes('戻ったタブ'), watcher.captionId), 'caption missing after returning');
  const third = await browser.newPage();
  await third.goto(url);
  await third.bringToFront();
  await third.emulateFocusedPage(true);
  await select(third);
  await until(() => jobs.length === 6, 'newly opened tab was not detected');
  jobs[5].resolve('新しいタブ');
  await until(async () => await third.evaluate(id => document.getElementById(id)?.shadowRoot.textContent.includes('新しいタブ'), watcher.captionId), 'caption missing on newly opened tab');
  await third.evaluate(() => getSelection().removeAllRanges());
  await second.bringToFront();
  await wait(11000);
  assert.equal(await third.evaluate(id => document.getElementById(id)?.shadowRoot.querySelector('div').textContent, watcher.captionId), '新しいタブ');
  await third.bringToFront();
  await select(third, 'h1');
  await until(() => jobs.length === 7, 'new selection did not replace retained caption');
  jobs[6].resolve('停止で消える字幕');
  await until(async () => await third.evaluate(id => document.getElementById(id)?.shadowRoot.textContent.includes('停止で消える字幕'), watcher.captionId), 'replacement caption missing');
  await watcher.stop();
  assert.equal(await third.$(`#${watcher.captionId}`), null);
  assert.equal(await second.$(`#${watcher.captionId}`), null);
  assert.equal(browser.connected, true);
});
