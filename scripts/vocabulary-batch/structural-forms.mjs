const normalize = value => value.normalize('NFKC').toLowerCase().trim().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nounIrregular = { child: ['children'], man: ['men'], woman: ['women'], person: ['people', 'persons'], mouse: ['mice'], goose: ['geese'], foot: ['feet'], tooth: ['teeth'], ox: ['oxen'], datum: ['data'], criterion: ['criteria'], phenomenon: ['phenomena'], analysis: ['analyses'], basis: ['bases'], crisis: ['crises'], thesis: ['theses'] };
const degreeIrregular = { good: ['better', 'best'], well: ['better', 'best'], bad: ['worse', 'worst'], badly: ['worse', 'worst'], far: ['farther', 'further', 'farthest', 'furthest'], little: ['less', 'least'], much: ['more', 'most'], many: ['more', 'most'] };

/** Candidate spellings only, never a claim of semantic or grammatical equivalence.
 * Every candidate still needs independent review against its complete sentence and choices.
 * No derivational suffix stripping (e.g. cloud -> cloudy) or fuzzy edit-distance matching.
 */
export function candidateContextForms(entry) {
  const base = normalize(entry.word), result = new Set([base]);
  for (const form of Object.values(entry.verbForms ?? {}).flat()) result.add(normalize(form));
  if (entry.partOfSpeech === '名詞') {
    if (nounIrregular[base]) nounIrregular[base].forEach(form => result.add(form));
    else if (/[^aeiou]y$/.test(base)) result.add(`${base.slice(0, -1)}ies`);
    else if (/(?:s|x|z|ch|sh)$/.test(base)) result.add(`${base}es`);
    else {
      result.add(`${base}s`);
      if (/fe?$/.test(base)) result.add(`${base.replace(/fe?$/, '')}ves`);
      if (/[^aeiou]o$/.test(base)) result.add(`${base}es`);
    }
  }
  if (['形容詞', '副詞'].includes(entry.partOfSpeech)) {
    if (degreeIrregular[base]) degreeIrregular[base].forEach(form => result.add(form));
    else {
      result.add(`more ${base}`); result.add(`most ${base}`);
      if (/[^aeiou]y$/.test(base)) { result.add(`${base.slice(0, -1)}ier`); result.add(`${base.slice(0, -1)}iest`); }
      else if (/e$/.test(base)) { result.add(`${base}r`); result.add(`${base}st`); }
      else {
        result.add(`${base}er`); result.add(`${base}est`);
        if (/^[a-z]*[^aeiou][aeiou][^aeiouwxy]$/.test(base)) { result.add(`${base}${base.at(-1)}er`); result.add(`${base}${base.at(-1)}est`); }
      }
    }
  }
  return result;
}

/** Identify the requested lemma while allowing an explicit sense or evidenced construction. */
export function meaningPromptIdentifiesLemma(prompt, entry) {
  const value = normalize(prompt), lemma = normalize(entry.word);
  if (value === lemma) return true;
  if (new RegExp(`^${escape(lemma)}\\s*\\([^()]{1,160}\\)$`, 'u').test(value)) return true;
  // A short phrase such as "deal with" is allowed only when it literally occurs in an
  // authored example and contains the target as a full token. The reviewer checks its sense.
  if (!/^[a-z]+(?:[-'][a-z]+)*(?: [a-z]+(?:[-'][a-z]+)*){1,5}$/.test(value)) return false;
  const word = new RegExp(`(?:^| )${escape(lemma)}(?: |$)`);
  const phrase = new RegExp(`(?<![a-z'-])${escape(value)}(?![a-z'-])`);
  return word.test(value) && entry.examples.some(example => phrase.test(normalize(example.text)));
}
