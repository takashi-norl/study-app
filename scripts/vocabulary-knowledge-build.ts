import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { vocabularyEntries } from '../src/server/vocabulary-catalog';
import { glossaryEntries } from '../src/server/vocabulary-glossary-catalog';
import { parseVocabularyBatch, vocabularyGeneratedIndexSchema } from '../src/server/vocabulary-generated';
import { compileVocabularyKnowledge, writeVocabularyKnowledge } from './vocabulary-knowledge-lib';

async function main() {
  const { values } = parseArgs({ options: { taxonomy: { type: 'string' }, annotations: { type: 'string' }, 'catalog-index': { type: 'string' }, output: { type: 'string' }, write: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: false, strict: true });
  if (values.help) {
    console.log('node --conditions=react-server --import tsx scripts/vocabulary-knowledge-build.ts [--write]\nDefault: validate and report without writing. Uses existing100 + indexed approved generated batches + authored semantic annotations. Optional --taxonomy, --annotations, --catalog-index, --output. No provider calls, embeddings, or runtime AI. Only changed generated shards are written.');
    return;
  }
  const catalogIndex = path.resolve(values['catalog-index'] ?? 'content/vocabulary-generated/index.json');
  const index = vocabularyGeneratedIndexSchema.parse(JSON.parse(await readFile(catalogIndex, 'utf8')));
  const entries = vocabularyEntries.map(entry => ({ entry, batchId: 'legacy-100' }));
  for (const batch of index.batches) {
    const data = parseVocabularyBatch(JSON.parse(await readFile(path.join(path.dirname(catalogIndex), batch.file), 'utf8')), batch);
    entries.push(...data.entries.map(entry => ({ entry, batchId: batch.id })));
  }
  const build = compileVocabularyKnowledge({ entries, glossary: glossaryEntries,
    taxonomy: JSON.parse(await readFile(values.taxonomy ?? 'content/vocabulary-knowledge/taxonomy.json', 'utf8')),
    annotations: JSON.parse(await readFile(values.annotations ?? 'content/vocabulary-knowledge/annotations.json', 'utf8')),
  });
  const output = path.resolve(values.output ?? 'content/vocabulary-knowledge/generated');
  const changes = values.write ? await writeVocabularyKnowledge(build, output) : undefined;
  console.log(JSON.stringify({ mode: values.write ? 'written' : 'dry-run', output, ...build.index, changes }, null, 2));
}
main().catch(error => { console.error(error instanceof Error && !('issues' in error) ? error.message : 'Knowledge data failed validation.'); process.exitCode = 1; });
