import { hashContent, normalizeForm } from './schema.mjs';

const isBase = unit => ['base-approved', 'frozen'].includes(unit.source);
export function baseLexicalSnapshot(registry) {
  return [...registry.units.values()].filter(isBase).map(unit => ({ id: unit.id, lemma: unit.lemma,
    aliases: [...unit.aliases].sort(), contentSha256: unit.contentSha256 ?? null })).sort((a, b) => a.id.localeCompare(b.id));
}
/** Independent sidecar approval, never a mutation/removal of paid source cards. */
export function applyCanonicalAudit(registry, proposal, review) {
  if (proposal?.schemaVersion !== 1 || !proposal.id || !proposal.createdBy || !Array.isArray(proposal.groups) ||
      proposal.baseSnapshotSha256 !== hashContent(baseLexicalSnapshot(registry))) throw new Error('Canonical-family audit is missing or stale for the complete base snapshot.');
  if (review?.schemaVersion !== 1 || review.sourceSha256 !== hashContent(proposal) || !review.reviewedBy || review.reviewedBy === proposal.createdBy || !Number.isFinite(Date.parse(review.reviewedAt)) || review.approved !== true || !Array.isArray(review.issues) || review.issues.length || review.coverage !== 'all-base-lexical-families') throw new Error('Independent complete canonical-family approval is required.');
  const next = { ...registry, units: new Map([...registry.units].map(([id, unit]) => [id, { ...unit }])) }, grouped = new Set(), canonicalKeys = new Set();
  for (const group of proposal.groups) {
    if (typeof group.canonicalLemma !== 'string' || group.canonicalLemma !== normalizeForm(group.canonicalLemma) || !group.canonicalLemma || !group.reasonJa?.trim() || !Array.isArray(group.memberIds) || group.memberIds.length < 2 || new Set(group.memberIds).size !== group.memberIds.length || canonicalKeys.has(group.canonicalLemma)) throw new Error('Invalid or repeated canonical-family group.');
    const members = group.memberIds.map(id => next.units.get(id));
    if (members.some((unit, index) => !unit || !isBase(unit) || grouped.has(group.memberIds[index])) || !members.some(unit => unit.lemma === group.canonicalLemma)) throw new Error('Canonical group must retain distinct approved source IDs and an existing canonical lemma.');
    if ([...next.units.values()].some(unit => isBase(unit) && unit.lemma === group.canonicalLemma && !group.memberIds.includes(unit.id))) throw new Error('Canonical group omits a source card sharing its canonical lemma.');
    canonicalKeys.add(group.canonicalLemma);
    for (const unit of members) { grouped.add(unit.id); unit.canonicalKey = group.canonicalLemma; }
  }
  const cards = [...next.units.values()].filter(isBase), headwords = new Set(cards.map(unit => unit.lemma)), families = new Set(cards.map(unit => unit.canonicalKey ?? unit.lemma));
  next.canonicalAudit = { proposalSha256: hashContent(proposal), reviewSha256: hashContent(review), baseSnapshotSha256: proposal.baseSnapshotSha256,
    sourceCardCount: cards.length, normalizedHeadwordCount: headwords.size, canonicalLexemeCount: families.size,
    groupedSourceIds: [...grouped].sort(), preservedAllSourceIdsAndSenses: true };
  return next;
}
