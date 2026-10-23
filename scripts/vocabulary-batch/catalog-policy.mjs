import { z } from 'zod';
import { hashVocabularyEntry } from './schema.mjs';
import { assertCatalogFamilies, assertFamilyContent, familyFor } from './canonical-policy.mjs';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const dispositionKinds = ['expansion-only', 'alias-only', 'invalid-lemma'];
export const catalogDispositionSchema = z.object({
  schemaVersion: z.literal(1), kind: z.enum(dispositionKinds), id: z.string().min(1),
  proposalId: z.string().min(1), proposalSha256: hash, reviewSha256: hash,
  seedSha256: hash, contentSha256: hash, contentReviewSha256: hash,
  reason: z.string().min(1), targetId: z.string().min(1).optional(), canonicalLemma: z.string().min(1).optional(),
  reviewedBy: z.string().min(1), reviewedAt: z.string().datetime(), appliedAt: z.string().datetime(),
}).strict();

export function originalSeed(seed) { const { catalogDisposition: _disposition, ...original } = seed; return original; }
/** An invalid exclusion fails closed rather than quietly counting or exporting it. */
export function dispositionFor(seed) {
  if (seed.catalogDisposition === undefined) return null;
  const disposition = catalogDispositionSchema.parse(seed.catalogDisposition);
  if (seed.frozen || disposition.id !== seed.id || hashVocabularyEntry(originalSeed(seed)) !== disposition.seedSha256
    || !['approved', 'rejected'].includes(seed.status)) throw new Error('Catalog disposition no longer matches its immutable seed.');
  return disposition;
}
export const isCatalogExcluded = seed => dispositionFor(seed) !== null;
export const isPublicCandidate = seed => { familyFor(seed); return !seed.inventoryHold && !isCatalogExcluded(seed); };

export function assertDispositionContent(seed, row) {
  assertFamilyContent(seed, row);
  const disposition = dispositionFor(seed);
  if (disposition && (row.entry?.id !== seed.id || hashVocabularyEntry(row.entry) !== disposition.contentSha256
    || hashVocabularyEntry(row.review) !== disposition.contentReviewSha256)) throw new Error('Catalog disposition content or original review has changed.');
  return disposition;
}

export function catalogCounts(words, grade) {
  const families = assertCatalogFamilies(words);
  const selected = words.filter(word => !grade || word.grade === grade);
  const publicCards = selected.filter(isPublicCandidate);
  // Completed sense cards stay public; only the reviewed representative consumes a slot.
  const eligible = words.filter(isPublicCandidate).filter(word => {
    const family = familyFor(word);
    return (!family || family.canonicalId === word.id) && (!grade || (family?.canonicalGrade ?? word.grade) === grade);
  });
  return { registered: selected.length, inventoryHolds: selected.filter(word => word.inventoryHold).length,
    catalogExcluded: selected.filter(isCatalogExcluded).length, baseEligible: eligible.length,
    baseCompleted: eligible.filter(word => ['approved', 'preserved'].includes(word.status)).length,
    baseApprovedNew: eligible.filter(word => word.status === 'approved').length,
    allApprovedNew: selected.filter(word => word.status === 'approved').length,
    baseRejected: eligible.filter(word => word.status === 'rejected').length,
    publicCardCount: publicCards.length, completedCardCount: publicCards.filter(word => ['approved', 'preserved'].includes(word.status)).length,
    canonicalMerges: publicCards.length - eligible.length,
    canonicalFamilyCount: grade ? new Set(publicCards.flatMap(word => word.catalogFamily ? [word.catalogFamily.familyId] : [])).size : families.size };
}

/** Partition first, then exclude: adding a disposition must never renumber later sets. */
export function publicCatalogGroups(words, approvedById, grade) {
  assertCatalogFamilies(words);
  const ordered = words.filter(word => word.grade === grade && !word.frozen), groups = [];
  for (let offset = 0; offset < ordered.length; offset += 100) {
    const entries = ordered.slice(offset, offset + 100).flatMap(word => isPublicCandidate(word) && approvedById.has(word.id) ? [approvedById.get(word.id)] : []);
    if (entries.length) groups.push({ ordinal: offset / 100 + 1, entries });
  }
  return groups;
}
