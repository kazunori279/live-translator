import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, wrapCaption, visibleRows } from '../app/static/js/caption-layout.mjs';
const measure = text => [...text].length * 10;

test('settings have defaults and enforce operator limits', () => {
  assert.deepEqual(normalizeSettings(), { maxChars: 32, maxLines: 3, fontSize: 32 });
  assert.deepEqual(normalizeSettings({ maxChars: 999, maxLines: 1, fontSize: 'bad' }),
    { maxChars: 120, maxLines: 2, fontSize: 32 });
});
test('wraps Japanese, Latin, explicit newlines, and unbroken long text', () => {
  assert.deepEqual(wrapCaption('日本語の字幕です', 4, 1000, measure), ['日本語の', '字幕です']);
  assert.deepEqual(wrapCaption('abcdef\r\nghijkl', 4, 30, measure), ['abc', 'def', 'ghi', 'jkl']);
});
test('preserves emoji and combining character graphemes', () => {
  assert.deepEqual(wrapCaption('👨‍👩‍👧‍👦e\u0301あ', 1, 1000, measure), ['👨‍👩‍👧‍👦', 'e\u0301', 'あ']);
});
test('limits physical rows across utterances and streaming replacements', () => {
  const settings = { maxChars: 5, maxLines: 4 };
  const entries = [{ text: 'old', expires: 100 }, { text: '1234567890abcdefghijk', expires: Infinity }];
  assert.deepEqual(visibleRows(entries, settings, 1000, measure, 10), ['67890', 'abcde', 'fghij', 'k']);
  entries[1].text += 'lmno';
  assert.deepEqual(visibleRows(entries, settings, 1000, measure, 10), ['67890', 'abcde', 'fghij', 'klmno']);
  assert.deepEqual(visibleRows([{ text: 'old', expires: 100 }], settings, 1000, measure, 101), []);
});
