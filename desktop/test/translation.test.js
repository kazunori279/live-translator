import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { translate, serverURL, loadLanguages } from '../src/translation.js';

async function mockServer(t, handler) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    handler(req, res, body ? JSON.parse(body) : null);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const options = { source: 'en', target: 'ja', text: 'Hello' };

test('uses one text-only POST and returns the translated caption', async t => {
  let requests = 0;
  const server = await mockServer(t, (req, res, body) => {
    requests++;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/translate');
    assert.deepEqual(body, { ...options, bidirectional: true });
    res.end(JSON.stringify({ text: 'こんにちは。', model: 'test-text-model' }));
  });
  assert.equal(await translate({ ...options, server }), 'こんにちは。');
  assert.equal(requests, 1);
});

test('cancellation interrupts pending translation', async t => {
  const abort = new AbortController();
  const server = await mockServer(t, () => abort.abort());
  await assert.rejects(translate({ ...options, server, signal: abort.signal }), { name: 'AbortError' });
});

test('server rejection is surfaced without retrying', async t => {
  let requests = 0;
  const server = await mockServer(t, (_req, res) => {
    requests++;
    res.statusCode = 502;
    res.end(JSON.stringify({ detail: 'Translation unavailable' }));
  });
  await assert.rejects(translate({ ...options, server }), /Translation unavailable/);
  assert.equal(requests, 1);
});

test('timeout, missing endpoint and empty responses are actionable errors', async t => {
  const server = await mockServer(t, () => {});
  await assert.rejects(translate({ ...options, server, timeoutMs: 50 }), /timed out/);
  const oldServer = await mockServer(t, (_req, res) => { res.statusCode = 404; res.end('{}'); });
  await assert.rejects(translate({ ...options, server: oldServer }), /Update the translation server/);
  const emptyServer = await mockServer(t, (_req, res) => res.end('{"text":""}'));
  await assert.rejects(translate({ ...options, server: emptyServer }), /No translation/);
});

test('rejects empty/oversized text and insecure remote servers', async () => {
  assert.throws(() => serverURL('http://example.com'), /HTTPS/);
  assert.throws(() => serverURL('https://user:password@example.com'), /HTTPS/);
  assert.equal(serverURL('https://example.com/').href, 'https://example.com/');
  await assert.rejects(translate({ ...options, text: ' ', server: 'https://example.com' }), /Select between/);
  await assert.rejects(translate({ ...options, text: 'x'.repeat(10001), server: 'https://example.com' }), /Select between/);
});

test('language metadata preserves popular ordering', async t => {
  const catalog = { languages: { en: 'English', ja: 'Japanese' }, popular: ['ja', 'en'] };
  const server = await mockServer(t, (req, res) => {
    assert.equal(req.url, '/api/languages');
    res.end(JSON.stringify(catalog));
  });
  assert.deepEqual(await loadLanguages(server), catalog);
});
