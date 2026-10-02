import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';

export function chromePortFile(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Google/Chrome/User Data/DevToolsActivePort');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'google-chrome/DevToolsActivePort');
}

export function parseChromeEndpoint(contents, host = '127.0.0.1') {
  const [port, route] = contents.trim().split(/\r?\n/).map(value => value.trim());
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(route)) {
    throw new Error('Chrome published an invalid debugging endpoint. Toggle remote debugging off and on in Chrome.');
  }
  // `localhost` can resolve to ::1, where a different Chrome may own the same
  // port. Chrome's settings server advertises IPv4, so use that exact address.
  return `ws://${host}:${port}${route}`;
}

export async function connectionOptions(endpoint = '', read = () => readFile(chromePortFile(), 'utf8')) {
  if (!endpoint) {
    let contents;
    try { contents = await read(); }
    catch { throw new Error('Chrome has not published its debugging endpoint. Enable remote debugging at chrome://inspect/#remote-debugging.'); }
    return { browserWSEndpoint: parseChromeEndpoint(contents) };
  }
  const url = new URL(endpoint);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  if (url.protocol === 'ws:') return { browserWSEndpoint: url.href };
  if (url.hostname !== '127.0.0.1') return { browserURL: url.href };
  // The settings server intentionally has no /json/version route. When its
  // advertised port matches, use the endpoint file instead of HTTP discovery.
  try {
    const discovered = new URL(parseChromeEndpoint(await read(), url.hostname));
    if (discovered.port === url.port) return { browserWSEndpoint: discovered.href };
  } catch { /* A traditional CLI-launched debugging server may have no file. */ }
  return { browserURL: url.href };
}

export async function connectChrome(endpoint, { signal, timeoutMs = 60000 } = {}) {
  const options = await connectionOptions(endpoint);
  let ws;
  let timer;
  let abort;
  let failed = false;
  const interrupted = new Promise((_, reject) => {
    abort = () => {
      failed = true;
      ws?.terminate();
      reject(new DOMException('Connection cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => {
      failed = true;
      ws?.terminate();
      reject(new Error('Chrome connection timed out. Allow the connection in Chrome, then retry.'));
    }, timeoutMs);
  });
  const connect = async () => {
    let endpointURL = options.browserWSEndpoint;
    if (!endpointURL) {
      const response = await fetch(new URL('/json/version', options.browserURL), {
        signal: AbortSignal.timeout(Math.min(timeoutMs, 10000)),
      });
      if (!response.ok) throw new Error(`Chrome discovery returned HTTP ${response.status}. Leave the endpoint blank for the Chrome settings connection.`);
      endpointURL = (await response.json()).webSocketDebuggerUrl;
    }
    if (failed) throw new DOMException('Connection cancelled', 'AbortError');
    ws = new WebSocket(endpointURL, { handshakeTimeout: timeoutMs, maxPayload: 16 * 1024 * 1024 });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const transport = {
      send(raw) {
        const command = JSON.parse(raw);
        // Attach directly to page targets. In Chrome's settings-based server,
        // tab-container auto-attach can remain pending indefinitely. We only
        // need pages; child frames are still attached within each page session.
        if (command.method === 'Target.setAutoAttach' && !command.sessionId) {
          command.params.filter = [{ type: 'page' }, { exclude: true }];
        }
        ws.send(JSON.stringify(command));
      },
      close() { ws.close(); },
    };
    ws.on('message', raw => transport.onmessage?.(raw.toString()));
    ws.on('close', () => transport.onclose?.());
    return puppeteer.connect({ transport, defaultViewport: null, protocolTimeout: 15000 });
  };
  try {
    return await Promise.race([connect(), interrupted]);
  } catch (error) {
    ws?.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
