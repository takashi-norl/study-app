import { z } from 'zod';
import { GRADES, hashVocabularyEntry, normalizeLemma } from './schema.mjs';

const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1);
export const catalogFamilySchema = z.object({
  schemaVersion: z.literal(1), familyId: text, canonicalId: text, canonicalLemma: text,
  canonicalGrade: z.enum(Object.keys(GRADES)), memberIds: z.array(text).min(2).max(10), id: text,
  seedSha256: hash, contentSha256: hash, contentReviewSha256: hash.nullable(), sourceKind: z.enum(['approved', 'frozen']),
  proposalId: text, proposalSha256: hash, reviewSha256: hash, reason: text,
  reviewedBy: text, reviewedAt: z.string().datetime(), appliedAt: z.string().datetime(),
}).strict();
export function seedBeforeFamily(seed) { const { catalogFamily: _family, ...original } = seed; return original; }
export function familyFor(seed) {
  if (seed.catalogFamily === undefined) return null;
  const family = catalogFamilySchema.parse(seed.catalogFamily);
  if (seed.inventoryHold || seed.catalogDisposition || family.id !== seed.id
    || hashVocabularyEntry(seedBeforeFamily(seed)) !== family.seedSha256
    || (family.sourceKind === 'frozen' ? !seed.frozen || seed.status !== 'preserved' || family.contentReviewSha256 !== null
      : seed.frozen || seed.status !== 'approved' || family.contentReviewSha256 === null)
    || !family.memberIds.includes(seed.id) || !family.memberIds.includes(family.canonicalId)
    || new Set(family.memberIds).size !== family.memberIds.length
    || family.canonicalLemma !== normalizeLemma(family.canonicalLemma)) throw new Error('Canonical family no longer matches its immutable completed seed.');
  return family;
}
function commonFamily(family) {
  const { id: _id, seedSha256: _seed, contentSha256: _content, contentReviewSha256: _review, sourceKind: _kind, ...common } = family;
  return common;
}
/** All members must be present together. Partial metadata may never free quota. */
export function assertCatalogFamilies(words) {
  const byId = new Map(words.map(word => [word.id, word]));
  if (byId.size !== words.length) throw new Error('Duplicate catalog seed identities.');
  const families = new Map();
  for (const seed of words) {
    const family = familyFor(seed); if (!family) continue;
    const canonical = byId.get(family.canonicalId);
    if (!canonical || canonical.word !== family.canonicalLemma || canonical.grade !== family.canonicalGrade) throw new Error('Canonical family target or grade differs.');
    const commonHash = hashVocabularyEntry(commonFamily(family));
    if (families.has(family.familyId) && families.get(family.familyId) !== commonHash) throw new Error('Conflicting canonical family identities.');
    families.set(family.familyId, commonHash);
    for (const id of family.memberIds) {
      const member = byId.get(id), other = member && familyFor(member);
      if (!other || hashVocabularyEntry(commonFamily(other)) !== commonHash) throw new Error('Canonical family has a missing or conflicting member.');
    }
  }
  return families;
}
export function assertFamilyContent(seed, row) {
  const family = familyFor(seed); if (!family) return null;
  if (!row?.entry || row.entry.id !== seed.id || row.entry.word !== seed.word || hashVocabularyEntry(row.entry) !== family.contentSha256
    || (family.sourceKind === 'frozen' ? row.contentSha256 !== family.contentSha256
      : row.review?.status !== 'approved' || row.review.contentSha256 !== family.contentSha256 || hashVocabularyEntry(row.review) !== family.contentReviewSha256)) throw new Error('Canonical family content or original review has changed.');
  return family;
}
