import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionOptions, parseChromeEndpoint } from '../src/chrome.js';

const file = '9222\n/devtools/browser/abc-123\n';
test('automatic settings connection uses IPv4 rather than another Chrome on ::1', async () => {
  assert.deepEqual(await connectionOptions('', async () => file), {
    browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
  });
});
test('settings port entered as HTTP uses the file, not the missing /json/version API', async () => {
  assert.deepEqual(await connectionOptions('http://localhost:9222', async () => file), {
    browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
  });
});
test('explicit other endpoints are preserved; missing files support traditional servers', async () => {
  assert.deepEqual(await connectionOptions('http://127.0.0.1:9333', async () => file), { browserURL: 'http://127.0.0.1:9333/' });
  assert.deepEqual(await connectionOptions('http://[::1]:9222', async () => file), { browserURL: 'http://[::1]:9222/' });
  assert.deepEqual(await connectionOptions('http://127.0.0.1:9222', async () => { throw new Error('ENOENT'); }), { browserURL: 'http://127.0.0.1:9222/' });
  assert.deepEqual(await connectionOptions('ws://localhost:9222/devtools/browser/manual', async () => file), { browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser/manual' });
});
test('invalid or absent automatic endpoint gives an accurate setup error', async () => {
  assert.throws(() => parseChromeEndpoint('99999\n/devtools/browser/abc'), /invalid debugging endpoint/);
  assert.throws(() => parseChromeEndpoint('9222\nhttps://other.example'), /invalid debugging endpoint/);
  await assert.rejects(connectionOptions('', async () => { throw new Error('ENOENT'); }), /has not published/);
});

test('a stalled Chrome connection times out and can be cancelled', async t => {
  const { WebSocketServer } = await import('ws');
  const { connectChrome } = await import('../src/chrome.js');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => {
    for (const client of server.clients) client.terminate();
    return new Promise(resolve => server.close(resolve));
  });
  const endpoint = `ws://127.0.0.1:${server.address().port}`;
  await assert.rejects(connectChrome(endpoint, { timeoutMs: 100 }), /timed out/);
  const abort = new AbortController();
  server.once('connection', () => abort.abort());
  await assert.rejects(connectChrome(endpoint, { signal: abort.signal }), { name: 'AbortError' });
});
