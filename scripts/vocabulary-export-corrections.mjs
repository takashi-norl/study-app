import { hashVocabularyEntry } from './vocabulary-batch/schema.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, keys) => value && hashVocabularyEntry(Object.keys(value).sort()) === hashVocabularyEntry(keys.sort());
const leafPath = /^\/(tests|questions)\/(0|[1-9]\d*)\/(prompt|explanation|choices\/[0-3](?:\/(?:text|meaning))?)$/;
function checkProvenance(patch) {
  const p = patch.provenance;
  if (!p || !sha(p.sourceProposalSha256) || !sha(p.independentReviewSha256) || p.reviewedBy !== '/root'
    || !Number.isFinite(Date.parse(p.reviewedAt)) || typeof p.sourceAuthor !== 'string' || !p.sourceAuthor.trim()
    || typeof p.independentReviewer !== 'string' || !p.independentReviewer.trim() || p.sourceAuthor === p.independentReviewer) throw Error('Leaf corrections require exact source and independent review provenance.');
}
function checkLeafOperation(operation) {
  const match = typeof operation.path === 'string' && operation.path.match(leafPath);
  if (!exactKeys(operation, ['kind', 'path', 'before', 'after']) || !match
    || typeof operation.before !== 'string' || !operation.before.trim() || typeof operation.after !== 'string' || !operation.after.trim()
    || operation.before === operation.after) throw Error('Only exact existing usage-test string leaves can be replaced.');
  const [, section, index, field] = match;
  if (field.startsWith('choices/') && (section === 'tests' ? field.split('/').length !== 3 : field.split('/').length !== 2)) throw Error('Invalid usage choice leaf.');
  const limit = field === 'prompt' || field === 'explanation' ? 500 : field.endsWith('/meaning') ? 160 : 220;
  if (operation.after.length > limit) throw Error('Editorial test text exceeds the existing field bound.');
  return { section, index: Number(index), keys: field.split('/') };
}
function replaceUsageLeaf(entry, operation) {
  const { section, index, keys } = checkLeafOperation(operation), item = entry[section]?.[index];
  if (!item || (section === 'tests' ? item.mode !== 'usage' : item.type !== 'usage' || item.id !== `${entry.id}-usage`)) throw Error('Editorial leaf must target this card\'s usage test or its exact legacy mirror.');
  let target = item;
  for (const key of keys.slice(0, -1)) {
    if (!target || !Object.hasOwn(target, key)) throw Error('Editorial string leaf is missing.');
    target = target[key];
  }
  const key = keys.at(-1);
  if (!target || !Object.hasOwn(target, key) || target[key] !== operation.before) throw Error('Editorial string leaf changed from its reviewed before value.');
  target[key] = operation.after;
}
function assertUsageMirror(entry) {
  const authored = entry.tests?.filter(item => item.mode === 'usage') ?? [], legacy = entry.questions?.filter(item => item.id === `${entry.id}-usage` && item.type === 'usage') ?? [];
  if (authored.length !== 1 || legacy.length !== 1) throw Error('An exact authored and legacy usage mirror is required.');
  const a = authored[0], b = legacy[0], choices = a.choices.map(item => item.text);
  if (choices.length !== 4 || new Set(choices.map(item => item.normalize('NFKC').trim().toLowerCase())).size !== 4
    || hashVocabularyEntry([a.prompt, choices, a.correctIndex, a.explanation]) !== hashVocabularyEntry([b.prompt, b.choices, b.correctIndex, b.explanation])) throw Error('Editorial authored usage and legacy question must remain exact mirrors with four distinct choices.');
}

/** Editorial display fixes never rewrite frozen generation, review or audio evidence. */
export function applyVocabularyExportCorrections(entry, catalog) {
  if (catalog?.schemaVersion !== 1 || catalog.reviewedBy !== '/root' || !Array.isArray(catalog.patches)) throw Error('Reviewed editorial corrections are required.');
  const matches = catalog.patches.filter(patch => patch.wordId === entry.id);
  if (!matches.length) return entry;
  if (matches.length !== 1) throw Error('Duplicate editorial correction.');
  const patch = matches[0], beforeHash = hashVocabularyEntry(entry);
  if (!Array.isArray(patch.operations) || !patch.operations.length) throw Error('Empty editorial correction.');
  const hasLeaves = patch.operations.some(operation => operation.kind === 'replace-test-leaf');
  if (hasLeaves || patch.provenance) checkProvenance(patch);
  const seenPaths = new Set();
  for (const operation of patch.operations) if (operation.kind === 'replace-test-leaf') {
    checkLeafOperation(operation);
    if (seenPaths.has(operation.path)) throw Error('Duplicate editorial string leaf.');
    seenPaths.add(operation.path);
  }
  if (beforeHash === patch.afterContentSha256) return entry;
  if (beforeHash !== patch.beforeContentSha256) throw Error(`Editorial source changed: ${entry.id}`);
  const next = structuredClone(entry), seen = new Set();
  for (const operation of patch.operations) {
    if (operation.kind === 'replace-test-leaf') { replaceUsageLeaf(next, operation); continue; }
    if (!exactKeys(operation, ['mode', 'field', 'removeExactAnswer', 'before', 'after']) || !['context', 'recall'].includes(operation.mode) || operation.field !== 'alternatives' || seen.has(operation.mode)
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
  if (hasLeaves) assertUsageMirror(next);
  if (hashVocabularyEntry(next) !== patch.afterContentSha256) throw Error('Editorial result differs from the independently reviewed result.');
  return next;
}
