export const DEFAULTS = { maxChars: 32, maxLines: 3, fontSize: 32 };
export function normalizeSettings(value = {}) {
  const result = {};
  for (const [key, min, max] of [['maxChars', 5, 120], ['maxLines', 2, 4], ['fontSize', 16, 120]]) {
    const n = Number(value?.[key]);
    result[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULTS[key];
  }
  return result;
}

// Count visible characters, preserving combining marks and joined emoji.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function wrapCaption(text, maxChars, maxWidth, measure) {
  const rows = [];
  let row = '', count = 0;
  for (const { segment } of segmenter.segment(text.replace(/\r\n?/g, '\n'))) {
    if (segment === '\n') {
      if (row) rows.push(row);
      row = ''; count = 0;
      continue;
    }
    if (row && (count >= maxChars || measure(row + segment) > maxWidth)) {
      rows.push(row);
      row = ''; count = 0;
    }
    row += segment;
    count++;
  }
  if (row) rows.push(row);
  return rows;
}

export function visibleRows(entries, settings, width, measure, now = Date.now()) {
  return entries.filter(entry => entry.expires > now)
    .flatMap(entry => wrapCaption(entry.text, settings.maxChars, width, measure))
    .slice(-settings.maxLines);
}
