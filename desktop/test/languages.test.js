import test from 'node:test';
import assert from 'node:assert/strict';
import { languageGroups, languagePair } from '../src/languages.js';

test('popular group contains ten unique valid languages, followed by sorted alternatives', () => {
  const languages = Object.fromEntries(Array.from({length: 12}, (_, i) => [`l${i}`, `Language ${String(i).padStart(2, '0')}`]));
  const popular = ['missing', 'l9', 'l9', ...Object.keys(languages)];
  const groups = languageGroups(languages, popular);
  assert.equal(groups[0].codes.length, 10);
  assert.equal(groups[0].codes[0], 'l9');
  assert.deepEqual(groups[1].codes, ['l10', 'l11']);
  assert.equal(new Set(groups.flatMap(group => group.codes)).size, 12);
});

test('restored pairs remain valid and distinct', () => {
  const languages = { en: 'English', ja: 'Japanese', fr: 'French' };
  assert.deepEqual(languagePair(languages, 'fr', 'en'), {source: 'fr', target: 'en'});
  assert.deepEqual(languagePair(languages, 'en', 'en'), {source: 'en', target: 'ja'});
  assert.deepEqual(languagePair(languages, 'missing', 'missing'), {source: 'en', target: 'ja'});
});
