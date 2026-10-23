import { hashVocabularyEntry } from './vocabulary-batch/schema.mjs';

/** Editorial display fixes never rewrite frozen generation, review or audio evidence. */
export function applyVocabularyExportCorrections(entry, catalog) {
  if (catalog?.schemaVersion !== 1 || catalog.reviewedBy !== '/root' || !Array.isArray(catalog.patches)) throw Error('Reviewed editorial corrections are required.');
  const matches = catalog.patches.filter(patch => patch.wordId === entry.id);
  if (!matches.length) return entry;
  if (matches.length !== 1) throw Error('Duplicate editorial correction.');
  const patch = matches[0], beforeHash = hashVocabularyEntry(entry);
  if (beforeHash === patch.afterContentSha256) return entry;
  if (beforeHash !== patch.beforeContentSha256) throw Error(`Editorial source changed: ${entry.id}`);
  if (!Array.isArray(patch.operations) || !patch.operations.length) throw Error('Empty editorial correction.');
  const next = structuredClone(entry), seen = new Set();
  for (const operation of patch.operations) {
    if (!['context', 'recall'].includes(operation.mode) || operation.field !== 'alternatives' || seen.has(operation.mode)
      || typeof operation.removeExactAnswer !== 'string' || !operation.removeExactAnswer.trim()) throw Error('Only exact context/recall alternative removals are supported.');
    seen.add(operation.mode);
    const targets = operation.mode === 'recall' ? [next.recall] : (next.tests ?? []).filter(test => test.mode === 'context');
    if (targets.length !== 1 || !targets[0] || !Array.isArray(targets[0].alternatives)) throw Error('Editorial target missing or ambiguous.');
    const target = targets[0];
    if (hashVocabularyEntry(target.alternatives) !== hashVocabularyEntry(operation.before)) throw Error('Editorial alternatives changed.');
    const remaining = target.alternatives.filter(alternative => alternative.answer !== operation.removeExactAnswer);
    if (remaining.length !== target.alternatives.length - 1 || hashVocabularyEntry(remaining) !== hashVocabularyEntry(operation.after)) throw Error('Editorial correction must remove exactly one specified alternative.');
    target.alternatives = remaining;
  }
  if (hashVocabularyEntry(next) !== patch.afterContentSha256) throw Error('Editorial result differs from the independently reviewed result.');
  return next;
}
