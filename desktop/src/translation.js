export const DEFAULT_SERVER = 'https://live-translation-761793285222.asia-northeast1.run.app';

export function serverURL(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
    throw new Error('Use an HTTPS server URL, or HTTP on localhost.');
  }
  url.pathname = url.pathname.replace(/\/$/, '') + '/';
  return url;
}

export async function loadLanguages(server) {
  const response = await fetch(new URL('api/languages', serverURL(server)), {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Cannot load languages (HTTP ${response.status}).`);
  const { languages } = await response.json();
  if (!languages || typeof languages !== 'object') throw new Error('Invalid language list.');
  return languages;
}

/** Text-only requests reuse HTTP connections; no Live session or audio is created. */
export async function translate({ server, source, target, text, signal, timeoutMs = 35000 }) {
  if (typeof text !== 'string' || !text.trim() || text.length > 10000) {
    throw new Error('Select between 1 and 10,000 characters.');
  }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  let data;
  try {
    response = await fetch(new URL('api/translate', serverURL(server)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, target, text: text.trim() }),
      signal: requestSignal,
    });
    data = await response.json();
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (timeout.aborted) throw new Error('Translation timed out. Select the text again to retry.');
    if (response?.status === 404) throw new Error('Update the translation server to support text captions.');
    if (error instanceof SyntaxError) throw new Error('Invalid translation response.');
    throw new Error('Cannot reach the translation server. Check the server URL and connection.');
  }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (!response.ok) {
    if (response.status === 404) throw new Error('Update the translation server to support text captions.');
    throw new Error(typeof data.detail === 'string' ? data.detail : `Translation failed (HTTP ${response.status}).`);
  }
  if (typeof data.text !== 'string' || !data.text.trim()) {
    throw new Error('No translation returned. Select the text again to retry.');
  }
  return data.text.trim();
}
