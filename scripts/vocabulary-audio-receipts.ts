import { parseArgs } from 'node:util';
import { mergeVocabularyAudioReceipts } from './vocabulary-audio-receipts-lib';

async function main() {
  const { values } = parseArgs({ options: { index: { type: 'string' }, receipts: { type: 'string', multiple: true }, 'audio-dir': { type: 'string' }, write: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: false, strict: true });
  if (values.help) {
    console.log(`node --conditions=react-server --import tsx scripts/vocabulary-audio-receipts.ts \\
  --index content/vocabulary-generated/index.json --receipts /private/path/receipts \\
  --audio-dir /private/path/generated-audio [--write]

Default: dry-run. --receipts accepts a JSON file or a directory and can be repeated.
--audio-dir verifies exact local timing metadata and MP3 integrity; use it for real imports.
Only matching batch.audio fields are changed; existing conflicting audio is never replaced.
The downloaded private Drive identifiers remain in server-side catalog data. No API call.
File identifiers cannot be authenticated offline; use receipts downloaded from the authenticated import screen.`);
    return;
  }
  if (!values.index || !values.receipts?.length) throw new Error('--index and at least one --receipts path are required.');
  console.log(JSON.stringify(await mergeVocabularyAudioReceipts({ index: values.index, receipts: values.receipts, audioDirectory: values['audio-dir'], write: values.write }), null, 2));
}
main().catch(error => { console.error(error instanceof Error && !('issues' in error) ? error.message : 'Audio receipts failed local validation.'); process.exitCode = 1; });
