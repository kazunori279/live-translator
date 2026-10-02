/** The server owns the popular-language ordering; all other entries appear once. */
export function languageGroups(languages, popular = []) {
  const codes = Object.keys(languages);
  const preferred = [...new Set(Array.isArray(popular) ? popular : [])]
    .filter(code => codes.includes(code)).slice(0, 10);
  const remaining = codes.filter(code => !preferred.includes(code))
    .sort((a, b) => languages[a].localeCompare(languages[b], 'en'));
  return [
    { label: 'Popular languages', codes: preferred },
    { label: 'All other languages', codes: remaining },
  ].filter(group => group.codes.length);
}

export function languagePair(languages, source, target) {
  const codes = Object.keys(languages);
  if (!codes.includes(source)) source = codes.includes('en') ? 'en' : codes[0];
  if (!codes.includes(target) || target === source) {
    target = codes.includes('ja') && source !== 'ja' ? 'ja' : codes.find(code => code !== source);
  }
  return { source, target };
}
