import { parseArgs } from 'node:util';
import { exportVocabularyAudioBundles } from './vocabulary-audio-export-lib';

async function main() {
  const { values } = parseArgs({ options: { catalog: { type: 'string' }, 'batch-id': { type: 'string' }, 'audio-dir': { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: false, strict: true });
  if (values.help) {
    console.log('node --conditions=react-server --import tsx scripts/vocabulary-audio-export.ts --catalog content/vocabulary-generated/BATCH.json --batch-id BATCH --audio-dir artifacts/vocabulary/audio --output artifacts/vocabulary/import\nCreates private browser-import files of at most 10 clips each. No API call. The indexed text batch must be deployed before its audio can be imported.');
    return;
  }
  if (!values.catalog || !values['batch-id'] || !values['audio-dir'] || !values.output) throw new Error('--catalog, --batch-id, --audio-dir, and --output are required.');
  console.log(JSON.stringify(await exportVocabularyAudioBundles({ catalog: values.catalog, batchId: values['batch-id'], audioDirectory: values['audio-dir'], output: values.output }), null, 2));
}
main().catch(error => { console.error(error instanceof Error && !('issues' in error) ? error.message : 'Audio export failed a local integrity check.'); process.exitCode = 1; });
