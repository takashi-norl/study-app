import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { VocabularyEntry } from '../src/lib/vocabulary-types';
import type { GlossaryEntry } from '../src/lib/vocabulary-glossary';
import type { KnowledgeDomainPage, KnowledgeIndex, KnowledgeLink, KnowledgeRelation, KnowledgeSentence, KnowledgeShard, KnowledgeTarget, KnowledgeWord } from '../src/lib/vocabulary-knowledge-generated-types';

const label = z.string().min(1).max(4000), identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/);
const tags = z.array(z.object({ id: identifier, labelJa: label }).passthrough());
const taxonomySchema = z.object({ schemaVersion: z.literal(1), domains: tags, scenes: tags, registers: tags, grammarTags: tags }).passthrough();
const annotationSchema = z.object({
  schemaVersion: z.literal(1), sourcePolicy: label,
  words: z.array(z.object({
    wordId: identifier, domains: z.array(identifier),
    sentenceAnnotations: z.array(z.object({ sentenceId: identifier, domains: z.array(identifier), scene: identifier, register: identifier, grammar: z.array(identifier), collocations: z.array(z.object({ phraseId: identifier, text: label })) })),
    relations: z.array(z.object({ id: identifier, type: z.enum(['contextual-synonym', 'antonym', 'contrast']), targetTerm: label, targetWordId: identifier.optional(), scope: z.enum(['recall', 'sentence']), evidenceIds: z.array(identifier).min(1), noteJa: label, limitationsJa: label, replacementText: label.optional() })),
  }).passthrough()),
  phrases: z.array(z.object({ id: identifier, term: label, meaningJa: label, aliases: z.array(label), grammar: z.array(identifier), evidenceIds: z.array(identifier), noteJa: label })),
}).passthrough();
const ordered = (values: Iterable<string>) => [...new Set(values)].sort();
export const normalizeKnowledgeTerm = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").trim().replace(/\s+/g, ' ');
export const knowledgeShardId = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 2);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Token = { text: string; normalized: string; start: number; end: number };
function tokens(text: string): Token[] {
  return Array.from(text.matchAll(/[\p{L}\p{N}]+(?:['’‘-][\p{L}\p{N}]+)*(?:(?<=[sS])['’‘](?![\p{L}\p{N}]))?/gu), match => ({ text: match[0], normalized: normalizeKnowledgeTerm(match[0]), start: match.index!, end: match.index! + match[0].length }));
}
type Trie = { children: Map<string, Trie>; targets: Map<string, Set<string>> };
const trie = (): Trie => ({ children: new Map(), targets: new Map() });
function addTerm(root: Trie, term: string, nodeId: string, form: string) {
  const pieces = tokens(term);
  if (!pieces.length || pieces[0].start !== 0 || pieces.at(-1)!.end !== term.length || pieces.some((piece, index) => index && !/^\s+$/.test(term.slice(pieces[index - 1].end, piece.start)))) return;
  let current = root;
  for (const token of pieces) {
    let child = current.children.get(token.normalized);
    if (!child) { child = trie(); current.children.set(token.normalized, child); }
    current = child;
  }
  const forms = current.targets.get(nodeId) ?? new Set(); forms.add(form); current.targets.set(nodeId, forms);
}
function candidates(targets: Map<string, Set<string>>): KnowledgeTarget[] {
  return [...targets].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([nodeId, forms]) => ({ nodeId, forms: ordered(forms) }));
}
/** Finite authored aliases only. Longest contiguous phrase wins; punctuation is never crossed. */
export function createKnowledgeMatcher(words: Pick<KnowledgeWord, 'id' | 'term' | 'aliases'>[]) {
  const root = trie();
  for (const word of words) {
    addTerm(root, word.term, word.id, 'lemma');
    for (const alias of word.aliases) addTerm(root, alias.text, word.id, alias.form);
  }
  return (text: string): KnowledgeLink[] => {
    const pieces = tokens(text), result: KnowledgeLink[] = [];
    for (let position = 0; position < pieces.length; position++) {
      let current = root, longest: { endToken: number; targets: KnowledgeTarget[] } | undefined;
      for (let next = position; next < pieces.length; next++) {
        if (next > position && !/^\s+$/.test(text.slice(pieces[next - 1].end, pieces[next].start))) break;
        const child = current.children.get(pieces[next].normalized);
        if (!child) break;
        current = child;
        if (current.targets.size) longest = { endToken: next, targets: candidates(current.targets) };
      }
      if (longest) {
        const start = pieces[position].start, end = pieces[longest.endToken].end;
        result.push({ start, end, text: text.slice(start, end), targets: longest.targets, ambiguous: longest.targets.length > 1 });
        position = longest.endToken;
      }
    }
    return result;
  };
}

type CatalogItem = { entry: VocabularyEntry; batchId: string };
export type KnowledgeBuildInput = { entries: CatalogItem[]; glossary: GlossaryEntry[]; taxonomy: unknown; annotations: unknown };
export type KnowledgeBuild = { index: KnowledgeIndex; files: Map<string, unknown> };
export function compileVocabularyKnowledge(input: KnowledgeBuildInput): KnowledgeBuild {
  const taxonomy = taxonomySchema.parse(input.taxonomy), annotations = annotationSchema.parse(input.annotations);
  for (const group of [taxonomy.domains, taxonomy.scenes, taxonomy.registers, taxonomy.grammarTags]) if (new Set(group.map(item => item.id)).size !== group.length) throw new Error('Duplicate taxonomy identifier.');
  const domainIds = new Set(taxonomy.domains.map(item => item.id)), sceneIds = new Set(taxonomy.scenes.map(item => item.id)), registerIds = new Set(taxonomy.registers.map(item => item.id)), grammarIds = new Set(taxonomy.grammarTags.map(item => item.id));
  const knownTags = (values: string[], set: Set<string>) => { if (values.some(value => !set.has(value))) throw new Error('Unknown semantic taxonomy tag.'); };
  const words = new Map<string, KnowledgeWord>(), sentences = new Map<string, KnowledgeSentence>(), sources = new Map<string, VocabularyEntry>();
  const unknownDomains = new Set<string>();
  const add = (node: KnowledgeWord) => { if (words.has(node.id)) throw new Error(`Duplicate knowledge node ${node.id}.`); words.set(node.id, node); };
  const addSentence = (sentence: Omit<KnowledgeSentence, 'domainIds' | 'grammar' | 'collocations' | 'links' | 'wordIds'>) => {
    identifier.parse(sentence.id);
    if (sentences.has(sentence.id)) throw new Error(`Duplicate sentence ${sentence.id}.`);
    sentences.set(sentence.id, { ...sentence, domainIds: [], grammar: [], collocations: [], links: [], wordIds: [] });
    words.get(sentence.ownerId)!.sentenceIds.push(sentence.id);
  };
  for (const { entry, batchId } of [...input.entries].sort((a, b) => a.entry.id.localeCompare(b.entry.id, 'en'))) {
    identifier.parse(entry.id); sources.set(entry.id, entry);
    const aliases: KnowledgeWord['aliases'] = [];
    if (entry.verbForms) for (const form of ['base', 'past', 'pastParticiple', 'presentParticiple', 'thirdPersonSingular'] as const) for (const text of entry.verbForms[form]) aliases.push({ text, form });
    const metadata = (entry as VocabularyEntry & { metadata?: { domains?: string[] } }).metadata;
    const rawDomains = metadata?.domains ?? [];
    for (const tag of rawDomains) if (!domainIds.has(tag)) unknownDomains.add(tag);
    add({ id: entry.id, kind: 'word', term: entry.word, meaning: entry.meaning, definition: entry.definition, level: entry.level, partOfSpeech: entry.partOfSpeech, batchId,
      senseId: `sense:${entry.id}:primary`, domainIds: ordered(rawDomains.filter(tag => domainIds.has(tag))), source: 'catalog', aliases, sentenceIds: [], mentionedIn: [], relations: [] });
    for (const example of entry.examples) addSentence({ id: `${entry.id}:${example.id}`, ownerId: entry.id, kind: 'example', text: example.text, translation: example.translation, contextLabel: example.context });
    addSentence({ id: `${entry.id}:recall`, ownerId: entry.id, kind: 'recall', text: entry.recall.prompt });
  }
  // Foundation nodes retain their own sense/ID. A later homograph remains an explicit candidate,
  // not an automatically merged meaning or an invented synonym.
  for (const entry of [...input.glossary].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    if (words.has(entry.id)) continue;
    const phrase = /\s/.test(entry.term), id = phrase ? `phrase:${entry.term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : entry.id;
    if (words.has(id)) throw new Error(`Duplicate foundation phrase ${id}.`);
    const aliases = entry.aliases.map(text => ({ text, form: 'alias' }));
    if (entry.verbForms) for (const form of ['base', 'past', 'pastParticiple', 'presentParticiple', 'thirdPersonSingular'] as const) for (const text of entry.verbForms[form]) aliases.push({ text, form });
    add({ id, kind: phrase ? 'phrase' : 'word', term: entry.term, meaning: entry.meaning, definition: entry.definition, level: entry.level,
      senseId: `sense:${id}:primary`, source: 'foundation', domainIds: [], aliases, sentenceIds: [], mentionedIn: [], relations: [] });
    for (const [index, example] of entry.examples.entries()) addSentence({ id: `${id}:example-${index + 1}`, ownerId: id, kind: 'example', text: example.text, translation: example.translation });
  }
  const phraseIds = new Set<string>();
  for (const phrase of annotations.phrases) {
    if (!phrase.id.startsWith('phrase:')) throw new Error('Authored phrase IDs must use the phrase namespace.');
    if (phraseIds.has(phrase.id)) throw new Error(`Duplicate authored phrase ${phrase.id}.`);
    phraseIds.add(phrase.id);
    knownTags(phrase.grammar, grammarIds);
    for (const evidence of phrase.evidenceIds) if (!sentences.has(evidence)) throw new Error(`Unknown phrase evidence ${evidence}.`);
    const previous = words.get(phrase.id);
    if (previous && normalizeKnowledgeTerm(previous.term) !== normalizeKnowledgeTerm(phrase.term)) throw new Error(`Phrase ID has conflicting terms: ${phrase.id}.`);
    const node: KnowledgeWord = previous ?? { id: phrase.id, kind: 'phrase', term: phrase.term, meaning: phrase.meaningJa, senseId: `sense:${phrase.id}:primary`, source: 'semantic-annotation', domainIds: [], aliases: [], sentenceIds: [], mentionedIn: [], relations: [] };
    node.aliases.push(...phrase.aliases.map(text => ({ text, form: 'alias' })));
    node.noteJa = phrase.noteJa; node.grammar = ordered(phrase.grammar); node.evidenceIds = ordered(phrase.evidenceIds);
    const matches = createKnowledgeMatcher([node]);
    for (const evidence of phrase.evidenceIds) if (!matches(sentences.get(evidence)!.text).length) throw new Error(`Phrase does not occur in evidence ${evidence}.`);
    if (!previous) words.set(node.id, node);
  }
  const annotated = new Set<string>(), relationIds = new Set<string>();
  for (const annotation of annotations.words) {
    const node = words.get(annotation.wordId);
    if (!node || !sources.has(node.id) || annotated.has(node.id)) throw new Error(`Unknown or duplicate annotated word ${annotation.wordId}.`);
    annotated.add(node.id); knownTags(annotation.domains, domainIds); node.domainIds = ordered(annotation.domains);
    const seenSentences = new Set<string>();
    for (const item of annotation.sentenceAnnotations) {
      const sentence = sentences.get(item.sentenceId);
      if (!sentence || sentence.ownerId !== node.id || sentence.kind !== 'example' || seenSentences.has(item.sentenceId)) throw new Error(`Unknown or repeated sentence annotation ${item.sentenceId}.`);
      seenSentences.add(item.sentenceId); knownTags(item.domains, domainIds); knownTags([item.scene], sceneIds); knownTags([item.register], registerIds); knownTags(item.grammar, grammarIds);
      for (const collocation of item.collocations) {
        const phrase = words.get(collocation.phraseId);
        if (!phrase || phrase.kind !== 'phrase' || !createKnowledgeMatcher([phrase])(sentence.text).some(link => normalizeKnowledgeTerm(link.text) === normalizeKnowledgeTerm(collocation.text))) throw new Error(`Collocation is not grounded in ${item.sentenceId}.`);
      }
      Object.assign(sentence, { domainIds: ordered(item.domains), scene: item.scene, register: item.register, grammar: ordered(item.grammar), collocations: item.collocations });
    }
    for (const relation of annotation.relations) {
      if (relationIds.has(relation.id)) throw new Error(`Duplicate semantic relation ${relation.id}.`);
      relationIds.add(relation.id);
      for (const id of relation.evidenceIds) {
        const evidence = sentences.get(id);
        if (!evidence || evidence.ownerId !== node.id || (relation.scope === 'recall' ? evidence.kind !== 'recall' : evidence.kind !== 'example')) throw new Error(`Invalid relation evidence ${id}.`);
      }
      if (relation.targetWordId && !words.has(relation.targetWordId)) throw new Error(`Unknown explicit relation target ${relation.targetWordId}.`);
      node.relations.push({ id: relation.id, type: relation.type, sourceSenseId: node.senseId, targetTerm: relation.targetTerm, targetIds: relation.targetWordId ? [relation.targetWordId] : [],
        scope: relation.scope, evidenceIds: ordered(relation.evidenceIds), noteJa: relation.noteJa, limitationsJa: relation.limitationsJa, replacementText: relation.replacementText, source: 'semantic-annotation' });
    }
  }
  for (const [id, source] of sources) {
    const node = words.get(id)!;
    for (const alternative of source.recall.alternatives ?? []) {
      if (node.relations.some(relation => relation.type === 'contextual-synonym' && relation.scope === 'recall' && normalizeKnowledgeTerm(relation.targetTerm) === normalizeKnowledgeTerm(alternative.answer))) continue;
      node.relations.push({ id: `relation:${id}:recall:${hash(alternative.answer).slice(0, 12)}`, type: 'contextual-synonym', sourceSenseId: node.senseId, targetTerm: alternative.answer,
        targetIds: [], scope: 'recall', evidenceIds: [`${id}:recall`], noteJa: alternative.explanation,
        limitationsJa: 'この設問の文脈に限った候補です。別の文脈でも置き換えられるとは限りません。', source: 'authored-recall' });
    }
  }
  const lexicon = new Map<string, Map<string, Set<string>>>();
  for (const node of words.values()) {
    node.aliases = [...new Map(node.aliases.map(alias => [`${normalizeKnowledgeTerm(alias.text)}|${alias.form}`, alias])).values()].sort((a, b) => stable(a).localeCompare(stable(b), 'en'));
    for (const alias of [{ text: node.term, form: 'lemma' }, ...node.aliases]) {
      const key = normalizeKnowledgeTerm(alias.text), targets = lexicon.get(key) ?? new Map<string, Set<string>>(), forms = targets.get(node.id) ?? new Set<string>();
      forms.add(alias.form); targets.set(node.id, forms); lexicon.set(key, targets);
    }
  }
  const match = createKnowledgeMatcher([...words.values()]), matchWords = createKnowledgeMatcher([...words.values()].filter(node => node.kind === 'word'));
  let linkCount = 0;
  for (const sentence of sentences.values()) {
    sentence.links = match(sentence.text); linkCount += sentence.links.length;
    sentence.wordIds = ordered(matchWords(sentence.text).flatMap(link => link.targets.map(target => target.nodeId)));
    for (const id of ordered([...sentence.links.flatMap(link => link.targets.map(target => target.nodeId)), ...sentence.wordIds])) words.get(id)!.mentionedIn.push(sentence.id);
  }
  let unresolved = 0;
  for (const node of words.values()) {
    node.sentenceIds.sort(); node.mentionedIn = ordered(node.mentionedIn);
    for (const relation of node.relations) {
      const matches = lexicon.get(normalizeKnowledgeTerm(relation.targetTerm));
      if (relation.targetIds.length && relation.targetIds.some(id => !matches?.has(id))) throw new Error(`Explicit target term does not match ${relation.id}.`);
      if (!relation.targetIds.length) relation.targetIds = ordered(matches?.keys() ?? []);
      if (!relation.targetIds.length) unresolved++;
    }
    node.relations.sort((a, b) => a.id.localeCompare(b.id, 'en'));
  }
  const domainSummaries = taxonomy.domains.map(domain => {
    const count = [...words.values()].filter(node => node.domainIds.includes(domain.id)).length;
    const sentenceCount = [...sentences.values()].filter(sentence => sentence.domainIds.includes(domain.id)).length;
    return { id: domain.id, labelJa: domain.labelJa, count, pages: Math.ceil(count / 100), sentenceCount, sentencePages: Math.ceil(sentenceCount / 100) };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const index: KnowledgeIndex = {
    schemaVersion: 1, sourceDigest: hash(stable({ entries: [...input.entries].sort((a, b) => a.entry.id.localeCompare(b.entry.id, 'en')), glossary: [...input.glossary].sort((a, b) => a.id.localeCompare(b.id, 'en')), taxonomy, annotations })), sourcePolicy: annotations.sourcePolicy, shardStrategy: 'sha256-first-byte', pageSize: 100,
    counts: { catalogWords: sources.size, nodes: words.size, sentences: sentences.size, links: linkCount, scopedRelations: [...words.values()].reduce((sum, node) => sum + node.relations.length, 0), phrases: [...words.values()].filter(node => node.kind === 'phrase').length },
    domains: domainSummaries, coverage: { annotatedWords: annotated.size, catalogWordsWithoutDomain: [...sources.keys()].filter(id => !words.get(id)!.domainIds.length).length, unknownDomainTags: ordered(unknownDomains), unresolvedRelationTargets: unresolved },
  };
  const files = new Map<string, unknown>([['index.json', index], ['taxonomy.json', taxonomy]]), shards = new Map<string, KnowledgeShard>();
  for (const node of [...words.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    const key = knowledgeShardId(node.id), shard = shards.get(key) ?? { schemaVersion: 1, words: Object.create(null), sentences: Object.create(null) };
    shard.words[node.id] = node;
    for (const id of node.sentenceIds) shard.sentences[id] = sentences.get(id)!;
    shards.set(key, shard);
  }
  for (const [key, shard] of shards) files.set(`words/${key}.json`, shard);
  const termShards = new Map<string, Record<string, KnowledgeTarget[]>>();
  for (const [term, targets] of [...lexicon].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const key = knowledgeShardId(term), shard = termShards.get(key) ?? Object.create(null); shard[term] = candidates(targets); termShards.set(key, shard);
  }
  for (const [key, terms] of termShards) files.set(`terms/${key}.json`, { schemaVersion: 1, terms });
  for (const domain of domainSummaries) {
    const nodes = [...words.values()].filter(node => node.domainIds.includes(domain.id)).sort((a, b) => a.term.localeCompare(b.term, 'en') || a.id.localeCompare(b.id, 'en'));
    files.set(`domains/${domain.id}/index.json`, { schemaVersion: 1, ...domain, pageSize: 100 });
    for (let offset = 0; offset < nodes.length; offset += 100) {
      const page: KnowledgeDomainPage = { schemaVersion: 1, domainId: domain.id, page: offset / 100, total: nodes.length, words: nodes.slice(offset, offset + 100).map(node => ({ id: node.id, term: node.term, meaning: node.meaning, level: node.level, kind: node.kind, batchId: node.batchId })) };
      files.set(`domains/${domain.id}/${String(offset / 100).padStart(3, '0')}.json`, page);
    }
    const examples = [...sentences.values()].filter(sentence => sentence.domainIds.includes(domain.id)).sort((a, b) => a.id.localeCompare(b.id, 'en'));
    for (let offset = 0; offset < examples.length; offset += 100) files.set(`domains/${domain.id}/sentences-${String(offset / 100).padStart(3, '0')}.json`, {
      schemaVersion: 1, domainId: domain.id, page: offset / 100, total: examples.length,
      sentences: examples.slice(offset, offset + 100).map(sentence => ({ id: sentence.id, ownerId: sentence.ownerId, text: sentence.text, translation: sentence.translation })),
    });
  }
  return { index, files };
}

/** Writes only changed shards and removes only files tracked by the previous compiler manifest. */
export async function writeVocabularyKnowledge(build: KnowledgeBuild, directory: string) {
  const root = path.resolve(directory), manifestPath = path.join(root, 'manifest.json');
  let previous: Record<string, string> = {};
  try { previous = z.object({ schemaVersion: z.literal(1), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).parse(JSON.parse(await readFile(manifestPath, 'utf8'))).files; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const hashes: Record<string, string> = {}; let written = 0, unchanged = 0;
  for (const [file, data] of [...build.files].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (!/^(?:index|taxonomy)\.json$|^(?:words|terms)\/[a-f0-9]{2}\.json$|^domains\/[a-z0-9_-]+\/(?:index|(?:sentences-)?[0-9]{3})\.json$/.test(file)) throw new Error('Unsafe knowledge shard path.');
    const content = `${stable(data)}\n`, contentHash = hash(content), target = path.join(root, file); hashes[file] = contentHash;
    let same = false;
    try { same = hash(await readFile(target, 'utf8')) === contentHash; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (same) { unchanged++; continue; }
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx');
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target); written++;
  }
  const obsolete = Object.keys(previous).filter(file => !Object.hasOwn(hashes, file));
  for (const file of obsolete) {
    if (!/^(?:words|terms)\/[a-f0-9]{2}\.json$|^domains\/[a-z0-9_-]+\/(?:index|(?:sentences-)?[0-9]{3})\.json$/.test(file)) continue;
    try { await unlink(path.join(root, file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await mkdir(root, { recursive: true });
  const content = `${stable({ schemaVersion: 1, files: hashes })}\n`;
  let old = ''; try { old = await readFile(manifestPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (old !== content) {
    const temporary = `${manifestPath}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx');
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, manifestPath);
  }
  return { written, unchanged, removed: obsolete.length, files: build.files.size };
}
