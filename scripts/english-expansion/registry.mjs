import { hashContent, normalizeForm, validateSeed } from './schema.mjs';

/** Registry identifies lexical forms, not exam/genre tags or individual senses. */
export function createRegistry({ approvedBatches = [], frozenEntries = [], ownInventory = [], retainedEntries = [] } = {}) {
  const units = new Map(), forms = new Map(), conflicts = [];
  function add(entry, source) {
    const lemma = normalizeForm(entry.lemma ?? entry.word), id = entry.id;
    if (!id || !lemma) throw new Error('Existing catalog identity is missing.');
    const aliases = [...(entry.aliases ?? []), ...Object.values(entry.verbForms ?? {}).flat()].map(normalizeForm);
    const identity = { id, lemma, source, aliases: [...new Set(aliases)].filter(alias => alias !== lemma) };
    const previous = units.get(id);
    if (previous && previous.lemma !== lemma) throw new Error('Existing ID resolves to different lemmas.');
    if (!previous) units.set(id, identity);
    for (const form of [lemma, ...identity.aliases]) {
      const owners = forms.get(form) ?? new Set();
      if (owners.size && !owners.has(id)) conflicts.push({ form, ids: [...owners, id] });
      owners.add(id); forms.set(form, owners);
    }
  }
  for (const document of approvedBatches) {
    if (document.schemaVersion !== 1 || !Array.isArray(document.entries)) throw new Error('Expected version-one approved base batches.');
    for (const item of document.entries) {
      if (item.review?.status !== 'approved' || hashContent(item.entry) !== item.review.contentSha256) throw new Error('Base catalog content is not hash-bound to approval.');
      add(item.entry, 'base-approved');
    }
  }
  for (const item of frozenEntries) {
    if (item.entry && hashContent(item.entry) !== item.contentSha256) throw new Error('Frozen catalog hash mismatch.');
    add(item.entry ?? item, 'frozen');
  }
  // Excluded paid assets and aliases remain reserved identities, never completed base units.
  for (const item of retainedEntries) add(item.entry, item.source);
  for (const raw of ownInventory) add(validateSeed(raw), 'expansion');
  return { units, forms, conflicts };
}

export function classifyCandidates(registry, rawCandidates) {
  // Never mutate the caller's registry: planning can be rerun safely.
  const forms = new Map([...registry.forms].map(([key, ids]) => [key, new Set(ids)]));
  const units = new Map(registry.units), accepted = [], overlapping = [], alreadyRegistered = [];
  for (const raw of rawCandidates) {
    const seed = validateSeed(raw), lemma = normalizeForm(seed.lemma);
    const previous = units.get(seed.id);
    if (previous) {
      if (previous.lemma !== lemma) throw new Error('Stable identity collision.');
      alreadyRegistered.push({ candidateId: seed.id, existingId: previous.id }); continue;
    }
    const matches = [...new Set([lemma, ...seed.aliases.map(normalizeForm)].flatMap(form => [...(forms.get(form) ?? [])]))];
    if (matches.length) { overlapping.push({ candidateId: seed.id, existingIds: matches, reason: 'canonical-or-alias-overlap', action: 'link-or-review-existing-unit; do-not-count-as-new' }); continue; }
    accepted.push(seed); units.set(seed.id, { id: seed.id, lemma, source: 'expansion', aliases: seed.aliases });
    for (const form of [lemma, ...seed.aliases.map(normalizeForm)]) forms.set(form, new Set([seed.id]));
  }
  return { accepted, overlapping, alreadyRegistered };
}

export function countDistinct(registry) {
  const forms = new Set([...registry.units.values()].filter(unit => ['base-approved', 'frozen', 'expansion'].includes(unit.source)).map(unit => unit.lemma));
  return { lexicalUnits: forms.size, words: [...forms].filter(form => !form.includes(' ')).length, phrases: [...forms].filter(form => form.includes(' ')).length };
}
