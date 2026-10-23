import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createKnowledgeMatcher, knowledgeShardId, normalizeKnowledgeTerm } from '../vocabulary-knowledge-lib';
import { canonicalJson, hashReading, validateReading, validateSeries } from './schema.mjs';
import { atomicJson } from '../vocabulary-batch/storage.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/);
const nodeSchema = z.object({ id, kind: z.enum(['word', 'phrase']), term: z.string().min(1).max(240), domainIds: z.array(id), aliases: z.array(z.object({ text: z.string().min(1).max(240), form: z.string().min(1).max(60) })) });
export type ReadingLexiconNode = z.infer<typeof nodeSchema>;
type Target = { nodeId: string; kind: 'word' | 'phrase'; forms: string[] };
type Span = { start: number; end: number; text: string; targets: Target[]; ambiguous: boolean };
export type ReadingKnowledgeLinks = {
  schemaVersion: 1;
  sourceDigest: string;
  vocabularySourceDigest: string;
  matchingPolicy: string;
  offsetUnit: 'utf16-code-unit';
  counts: { readings: number; paragraphs: number; spans: number; resolvedGlosses: number; unresolvedGlosses: number };
  readings: {
    readingId: string; seriesId: string; contentSha256: string; domainIds: string[];
    relatedWordIds: string[]; relatedPhraseIds: string[];
    paragraphs: { paragraphId: string; textSha256: string; spans: Span[]; relatedWordIds: string[]; relatedPhraseIds: string[] }[];
    glossary: { term: string; meaningJa: string; status: 'resolved' | 'unresolved'; targets: Target[]; ambiguous: boolean }[];
  }[];
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const ordered = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en'));
async function readBounded(file: string, max = 20 * 1024 * 1024) {
  if ((await stat(file)).size > max) throw new Error('Reading link input exceeds its size limit.');
  return readFile(file, 'utf8');
}

/** Use only indexed, independently approved series. Draft files are never opened. */
export async function loadApprovedReadings(indexPath: string) {
  const index = z.object({ schemaVersion: z.literal(1), series: z.array(z.object({ id, file: z.string().regex(/^[a-z0-9][a-z0-9-]*\.json$/), reviewStatus: z.enum(['draft', 'approved']), passageCount: z.number().int().positive(), questionCount: z.number().int().nonnegative() })).max(100) }).parse(JSON.parse(await readBounded(indexPath)));
  const seen = new Set<string>(), files = new Set<string>(), readings = [];
  for (const descriptor of index.series) {
    if (seen.has(descriptor.id) || files.has(descriptor.file)) throw new Error('Duplicate indexed reading series or file.');
    seen.add(descriptor.id); files.add(descriptor.file);
    if (descriptor.reviewStatus !== 'approved') continue;
    const file = path.join(path.dirname(indexPath), descriptor.file);
    const series = z.object({ schemaVersion: z.literal(1), seriesId: id, reviewStatus: z.literal('approved'), readings: z.array(z.unknown()) }).parse(JSON.parse(await readBounded(file)));
    if (series.seriesId !== descriptor.id) throw new Error('Reading series identity differs from its index.');
    const checked: ReturnType<typeof validateReading>[] = validateSeries(series.readings, descriptor.id);
    if (checked.some(reading => reading.review.status !== 'approved') || checked.length !== descriptor.passageCount || checked.reduce((sum, reading) => sum + reading.questions.length, 0) !== descriptor.questionCount) throw new Error('Indexed reading approval or counts do not match the series.');
    readings.push(...checked);
  }
  return { readings, sourceFiles: [...files].map(file => path.resolve(path.dirname(indexPath), file)) };
}

/** Read the existing finite lexicon with its compiler hashes; no invented morphology. */
export async function loadKnowledgeLexicon(directory: string) {
  const manifest = z.object({ schemaVersion: z.literal(1), files: z.record(z.string(), digest) }).parse(JSON.parse(await readBounded(path.join(directory, 'manifest.json'))));
  const verified = async (file: string) => {
    const content = await readBounded(path.join(directory, file));
    if (!Object.hasOwn(manifest.files, file) || sha(content) !== manifest.files[file]) throw new Error(`Knowledge input failed its saved hash: ${file}`);
    return JSON.parse(content);
  };
  const index = z.object({ schemaVersion: z.literal(1), sourceDigest: digest, counts: z.object({ nodes: z.number().int().nonnegative() }) }).parse(await verified('index.json'));
  const nodes: ReadingLexiconNode[] = [], seen = new Set<string>();
  for (const file of Object.keys(manifest.files).filter(file => file.startsWith('words/')).sort()) {
    if (!/^words\/[a-f0-9]{2}\.json$/.test(file)) throw new Error('Unsafe knowledge word shard path.');
    const shard = z.object({ schemaVersion: z.literal(1), words: z.record(z.string(), nodeSchema) }).parse(await verified(file));
    for (const [key, node] of Object.entries(shard.words)) {
      if (key !== node.id || seen.has(node.id) || file !== `words/${knowledgeShardId(node.id)}.json`) throw new Error('Knowledge node identity or shard mismatch.');
      seen.add(node.id); nodes.push(node);
    }
  }
  if (nodes.length !== index.counts.nodes) throw new Error('Knowledge node count differs from the generated index.');
  return { sourceDigest: index.sourceDigest, nodes };
}

/** Offsets refer to exact source text. Longest known phrase wins; homographs stay candidates. */
export function compileReadingKnowledgeLinks(rawReadings: unknown[], lexicon: { sourceDigest: string; nodes: ReadingLexiconNode[] }): ReadingKnowledgeLinks {
  digest.parse(lexicon.sourceDigest);
  const nodes = lexicon.nodes.map(node => nodeSchema.parse(node)).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (nodes.length !== byId.size) throw new Error('Duplicate lexicon node ID.');
  const readings = rawReadings.map(validateReading).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  if (new Set(readings.map(reading => reading.id)).size !== readings.length || readings.some(reading => reading.review.status !== 'approved')) throw new Error('Reading links require unique, independently approved readings.');
  const match = createKnowledgeMatcher(nodes);
  const targets = (items: { nodeId: string; forms: string[] }[]): Target[] => items.map(item => ({ nodeId: item.nodeId, kind: byId.get(item.nodeId)!.kind, forms: ordered(item.forms) }));
  const related = (items: Target[], kind: 'word' | 'phrase') => ordered(items.filter(item => item.kind === kind).map(item => item.nodeId));
  const counts = { readings: readings.length, paragraphs: 0, spans: 0, resolvedGlosses: 0, unresolvedGlosses: 0 };
  const linked = readings.map(reading => {
    const paragraphs = reading.paragraphs.map(paragraph => {
      const spans = match(paragraph.text).map(item => ({ ...item, targets: targets(item.targets) }));
      counts.paragraphs++; counts.spans += spans.length;
      const all = spans.flatMap(span => span.targets);
      return { paragraphId: paragraph.id, textSha256: sha(paragraph.text), spans, relatedWordIds: related(all, 'word'), relatedPhraseIds: related(all, 'phrase') };
    });
    const glossary = reading.vocabulary.map(gloss => {
      // An exact whole-term lookup may resolve an explicitly stored inflection or alias.
      // A partial match inside an unknown compound is not a definition of that compound.
      const found = match(gloss.term).filter(span => span.start === 0 && span.end === gloss.term.length && normalizeKnowledgeTerm(span.text) === normalizeKnowledgeTerm(gloss.term));
      const candidates = found.length === 1 ? targets(found[0].targets) : [];
      const status = candidates.length ? 'resolved' as const : 'unresolved' as const;
      counts[status === 'resolved' ? 'resolvedGlosses' : 'unresolvedGlosses']++;
      return { term: gloss.term, meaningJa: gloss.meaningJa, status, targets: candidates, ambiguous: candidates.length > 1 };
    });
    return { readingId: reading.id, seriesId: reading.seriesId, contentSha256: hashReading(reading), domainIds: ordered(reading.domainIds),
      relatedWordIds: ordered(paragraphs.flatMap(paragraph => paragraph.relatedWordIds)), relatedPhraseIds: ordered(paragraphs.flatMap(paragraph => paragraph.relatedPhraseIds)), paragraphs, glossary };
  });
  return { schemaVersion: 1, sourceDigest: sha(canonicalJson({ vocabularySourceDigest: lexicon.sourceDigest, lexicon: nodes, readings: linked })), vocabularySourceDigest: lexicon.sourceDigest,
    matchingPolicy: 'Exact known lemmas, authored aliases and explicit inflections only; longest phrase wins; ambiguous targets remain candidates. Unknown words stay plain text. Glossary resolution is a lexical link, not a claim that every sense is interchangeable.',
    offsetUnit: 'utf16-code-unit', counts, readings: linked };
}

export async function writeReadingKnowledgeLinks(file: string, result: ReadingKnowledgeLinks) {
  const content = `${JSON.stringify(result, null, 2)}\n`;
  try { if (await readFile(file, 'utf8') === content) return { written: false }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await atomicJson(file, result);
  return { written: true };
}

async function main() {
  const { values } = parseArgs({ options: { 'reading-index': { type: 'string' }, 'knowledge-dir': { type: 'string' }, output: { type: 'string' }, write: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: false, strict: true });
  if (values.help) { console.log('node --import tsx scripts/reading-batch/knowledge-links.ts [--write]\nDefault: validate approved indexed readings and generated vocabulary shards, report counts without writing. No API calls. Re-run after rebuilding vocabulary knowledge to add links for new known words. Optional --reading-index, --knowledge-dir, --output.'); return; }
  const readingIndex = path.resolve(values['reading-index'] ?? 'content/reading-generated/index.json');
  const knowledgeDir = path.resolve(values['knowledge-dir'] ?? 'content/vocabulary-knowledge/generated');
  const output = path.resolve(values.output ?? 'content/reading-generated/knowledge-links.json');
  const { readings, sourceFiles } = await loadApprovedReadings(readingIndex);
  if ([readingIndex, ...sourceFiles].includes(output) || output === knowledgeDir || output.startsWith(`${knowledgeDir}${path.sep}`)) throw new Error('The sidecar output must not overwrite its source files.');
  const result = compileReadingKnowledgeLinks(readings, await loadKnowledgeLexicon(knowledgeDir));
  const changes = values.write ? await writeReadingKnowledgeLinks(output, result) : undefined;
  console.log(JSON.stringify({ mode: values.write ? 'written' : 'dry-run', output, sourceDigest: result.sourceDigest, ...result.counts, changes }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error && !('issues' in error) ? error.message : 'Reading link inputs failed validation.'); process.exitCode = 1; });
