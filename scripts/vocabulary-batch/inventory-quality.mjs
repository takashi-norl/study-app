import { z } from 'zod';
import { hashVocabularyEntry, inventorySchema, lemmaSchema, normalizeLemma } from './schema.mjs';

/** Opt-in for NEW inventory requests only. Never change a saved request's schema/hash. */
export function futureInventoryRequestSchema(domainIds) {
  if (!Array.isArray(domainIds) || !domainIds.length || domainIds.some(id => typeof id !== 'string' || !id)
    || new Set(domainIds).size !== domainIds.length) throw new Error('Provide distinct canonical domain IDs.');
  const word = lemmaSchema.extend({ domains: z.array(z.enum(domainIds)).min(1).max(4) }).strict();
  // An honest empty result is preferable to obscure filler. The caller must still stop on zero yield.
  return inventorySchema.extend({ words: z.array(word).min(0).max(100) }).strict();
}

/** Diagnostics only: structural novelty is not an approval of a lemma's meaning or curricular value. */
export function auditInventoryCandidates(raw, { knownLemmas, domainIds, needed }) {
  if (!raw || !Array.isArray(raw.words) || raw.words.length > 200 || !Number.isInteger(needed) || needed < 1 || needed > 100
    || !(knownLemmas instanceof Set) || !Array.isArray(domainIds) || !domainIds.length) throw new Error('Invalid inventory audit input.');
  const known = new Set([...knownLemmas].map(normalizeLemma)), domains = new Set(domainIds), seen = new Set();
  const rows = raw.words.map((candidate, index) => {
    const parsed = lemmaSchema.safeParse(candidate);
    const key = typeof candidate?.word === 'string' ? normalizeLemma(candidate.word) : null;
    const invalidDomains = Array.isArray(candidate?.domains) ? candidate.domains.filter(id => !domains.has(id)) : [];
    const duplicate = key !== null && known.has(key), duplicateWithinResponse = key !== null && seen.has(key);
    if (key) seen.add(key);
    return { index, word: candidate?.word ?? null, duplicate, duplicateWithinResponse, invalidDomains,
      schemaIssues: parsed.success ? [] : parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })),
      structurallyNovel: parsed.success && !duplicate && !duplicateWithinResponse && !invalidDomains.length };
  });
  const novel = rows.filter(row => row.structurallyNovel), selected = novel.slice(0, needed);
  const lowYield = rows.length >= 20 && selected.length / needed < 0.25;
  const firstLetters = {};
  for (const row of rows) if (row.word) firstLetters[row.word[0]] = (firstLetters[row.word[0]] ?? 0) + 1;
  return { returned: rows.length, requested: needed, selectedCount: selected.length,
    duplicateCount: rows.filter(row => row.duplicate).length,
    invalidDomainCount: rows.filter(row => row.invalidDomains.length).length,
    schemaFailureCount: rows.filter(row => row.schemaIssues.length).length,
    alphabeticConcentration: rows.length ? Math.max(0, ...Object.values(firstLetters)) / rows.length : 0,
    action: !selected.length || lowYield ? 'stop-for-inventory-review' : 'review-novel-candidates',
    paidRetryAuthorized: false, rows };
}

/** Future request advice, not a model-based quality verdict or a frequency claim. */
export const INVENTORY_QUALITY_INSTRUCTIONS = [
  'Choose useful modern general-English lemmas for this learning band; the count is a ceiling, not a quota.',
  'Return fewer items, including an empty list if necessary, rather than obscure, archaic, highly technical or taxonomic filler.',
  'Check every candidate against the full excludedLemmas list before output. Do not restart an alphabetical dictionary walk at A.',
  'Balance ordinary learning situations across the supplied domains. A tag does not make a specialist term general vocabulary.',
  'Use only the exact supplied canonical domain IDs. Never invent a domain label or assign a broad topic to an unsupported specialist sense.',
  'Do not add another spelling, inflection, or word-family derivative solely to fill a slot. A derivative needs a distinct useful learning purpose.',
  'Approximate CEFR or exam labels are metadata, not evidence of usefulness, frequency, or official exam inclusion.',
];

/** A diversity hint for NEW requests; never enforce rare filler to fill an initial/domain bucket. */
export function inventoryFocusForRound(round, domainIds) {
  if (!Number.isInteger(round) || round < 0 || !Array.isArray(domainIds) || !domainIds.length
    || new Set(domainIds).size !== domainIds.length || domainIds.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid inventory rotation input.');
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const first = (round * 7) % alphabet.length;
  return {
    preferredInitialLetters: Array.from({ length: 6 }, (_, offset) => alphabet[(first + offset) % alphabet.length]),
    preferredDomains: Array.from({ length: Math.min(4, domainIds.length) }, (_, offset) => domainIds[(round + offset) % domainIds.length]),
    policy: 'Prefer these starting letters and everyday senses within these domains to escape repeated A-only lists. They are diversity hints, not quotas. Other useful initials/domains are allowed; return fewer words instead of specialist filler.',
  };
}

/** Build a reversible, hash-bound PROPOSAL. No files, statuses, receipts, or requests are changed. */
export function planInventoryQuarantine(state, decisions, generationGroups = []) {
  if (!state || !Array.isArray(state.words) || !Array.isArray(decisions) || !Array.isArray(generationGroups)) throw new Error('Invalid quarantine proposal input.');
  const byId = new Map(state.words.map(word => [word.id, word]));
  if (byId.size !== state.words.length || new Set(decisions.map(decision => decision.id)).size !== decisions.length) throw new Error('Duplicate word or decision identity.');
  const selected = decisions.map(decision => {
    const word = byId.get(decision.id);
    if (!word || word.frozen || word.status !== 'inventoried') throw new Error('Only current unfrozen inventoried seeds may be proposed for an inventory hold.');
    if (typeof decision.reason !== 'string' || !decision.reason.trim() || decision.contentSha256 !== hashVocabularyEntry(word)) throw new Error('Missing reason or stale seed revision.');
    return { ...decision, originalSeed: structuredClone(word) };
  });
  const byWord = new Map(selected.map(decision => [normalizeLemma(decision.originalSeed.word), decision.id]));
  const affectedGroups = generationGroups.filter(group => group.entries.some(entry => byWord.has(normalizeLemma(entry.word))));
  const grouped = new Set(affectedGroups.flatMap(group => group.entries.map(entry => byWord.get(normalizeLemma(entry.word)))).filter(Boolean));
  const knownStatuses = new Set(['complete', 'batch_pending', 'requested', 'uncertain', 'prepared-only']);
  for (const group of affectedGroups) if (!group.requestId || !/^[a-f0-9]{64}$/.test(group.requestHash ?? '') || !knownStatuses.has(group.status)) throw new Error('Generation group has an unresolved request identity/status.');
  const groups = affectedGroups.map(group => ({ requestId: group.requestId, requestHash: group.requestHash,
    status: group.status, affectedIds: group.entries.map(entry => byWord.get(normalizeLemma(entry.word))).filter(Boolean),
    preserveAllGroupWords: group.entries.map(entry => entry.word),
    action: 'retain-entire-group-and-raw; defer-further-submission-until-reviewed',
    requiresProviderReconciliation: ['batch_pending', 'requested', 'uncertain'].includes(group.status) }));
  return { schemaVersion: 1, status: 'proposal-not-applied', sourceManifestSha256: hashVocabularyEntry(state),
    proposedSeeds: selected, untouchedSeedIds: selected.filter(decision => !grouped.has(decision.id)).map(decision => decision.id),
    preserveAndHoldGroups: groups, paidCallsAuthorized: false,
    applyPolicy: 'Re-read under the manifest lock and require exact seed/request identity. Never remove or regroup paid/prepared siblings. Preserve the original seed, ledger and raw response for reversal. This helper does not apply a hold.' };
}
