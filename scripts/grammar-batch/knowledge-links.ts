import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { validateApprovedLessons, hashLesson, canonicalJson } from './schema.mjs';
import { createKnowledgeMatcher } from '../vocabulary-knowledge-lib';
import { loadKnowledgeLexicon } from '../reading-batch/knowledge-links';

type GrammarLesson = {
  id: string; series: string; domainIds: string[];
  examples: { id: string; text: string }[];
  contrasts: { leftEnglish: string; rightEnglish: string }[];
};

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const ordered = (items: string[]) => [...new Set(items)].sort();
const courseSchema = z.object({
  schemaVersion: z.literal(1), courseId: z.literal('english-grammar-foundations-v1'),
  reviewStatus: z.literal('approved'), publicationStatus: z.literal('unpublished'),
  lessons: z.array(z.record(z.string(), z.unknown())),
});
/** Link only examples and contrasts; answer options are deliberately outside the learning lexicon. */
export function compileGrammarKnowledgeLinks(raw: unknown, lexicon: Awaited<ReturnType<typeof loadKnowledgeLexicon>>) {
  const course = courseSchema.parse(raw);
  const approved = validateApprovedLessons(course.lessons) as (GrammarLesson & { contentSha256: string; review: unknown; audio: unknown })[];
  const lessons = approved.map(({ contentSha256, review, audio, ...lesson }) => lesson);
  digest.parse(lexicon.sourceDigest);
  if (new Set(lexicon.nodes.map(node => node.id)).size !== lexicon.nodes.length) throw new Error('Duplicate lexicon node.');
  const match = createKnowledgeMatcher(lexicon.nodes);
  const byId = new Map(lexicon.nodes.map(node => [node.id, node]));
  let sentences = 0, spanCount = 0;
  const linked = lessons.map(lesson => {
    const texts = [
      ...lesson.examples.map(example => ({ id: example.id, kind: 'example', text: example.text })),
      ...lesson.contrasts.flatMap((contrast, index) => [
        { id: `${lesson.id}-contrast-${index + 1}-left`, kind: 'contrast', text: contrast.leftEnglish },
        { id: `${lesson.id}-contrast-${index + 1}-right`, kind: 'contrast', text: contrast.rightEnglish },
      ]),
    ];
    const textsWithLinks = texts.map(sentence => {
      const spans = match(sentence.text).map(span => ({ ...span, targets: span.targets.map(target => ({ ...target, kind: byId.get(target.nodeId)!.kind })) }));
      sentences++; spanCount += spans.length;
      return { sentenceId: sentence.id, kind: sentence.kind, textSha256: sha(sentence.text), spans };
    });
    return {
      lessonId: lesson.id, series: lesson.series, contentSha256: hashLesson(lesson), domainIds: lesson.domainIds,
      relatedWordIds: ordered(textsWithLinks.flatMap(sentence => sentence.spans.flatMap(span => span.targets.filter(target => target.kind === 'word').map(target => target.nodeId)))),
      relatedPhraseIds: ordered(textsWithLinks.flatMap(sentence => sentence.spans.flatMap(span => span.targets.filter(target => target.kind === 'phrase').map(target => target.nodeId)))),
      sentences: textsWithLinks,
    };
  });
  return {
    schemaVersion: 1, courseId: course.courseId, vocabularySourceDigest: lexicon.sourceDigest,
    sourceDigest: sha(canonicalJson({ vocabularySourceDigest: lexicon.sourceDigest, lessons: linked })),
    offsetUnit: 'utf16-code-unit',
    matchingPolicy: 'Exact known words, phrases and authored inflections; longest phrase wins; ambiguous forms retain all candidates. Lexical links do not assert identical senses. Unknown terms remain plain text.',
    counts: { lessons: linked.length, sentences, spans: spanCount }, lessons: linked,
  };
}

async function main() {
  const { values } = parseArgs({ options: { write: { type: 'boolean' } }, strict: true, allowPositionals: false });
  const input = new URL('../../content/grammar-generated/series-v1.json', import.meta.url);
  if ((await stat(input)).size > 5 * 1024 * 1024) throw new Error('Grammar course exceeds the input size limit.');
  const result = compileGrammarKnowledgeLinks(JSON.parse(await readFile(input, 'utf8')), await loadKnowledgeLexicon(fileURLToPath(new URL('../../content/vocabulary-knowledge/generated/', import.meta.url))));
  const output = fileURLToPath(new URL('../../content/grammar-generated/knowledge-links.json', import.meta.url));
  let written = false;
  if (values.write) {
    const text = `${JSON.stringify(result, null, 2)}\n`;
    const { atomicJson } = await import('../vocabulary-batch/storage.mjs');
    let previous = '';
    try { previous = await readFile(output, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (text !== previous) { await atomicJson(output, result); written = true; }
  }
  console.log(JSON.stringify({ mode: values.write ? 'write' : 'dry-run', ...result.counts, written }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error && !('issues' in error) ? error.message : 'Grammar linkage input failed validation.'); process.exitCode = 1; });
