/** Run with: node --conditions=react-server --import tsx scripts/vocabulary-audio-batch.ts --help */
import { parseArgs } from 'node:util';
import { vocabularyEntries } from '../src/server/vocabulary-catalog';
import { AUDIO_BATCH_BUDGET_USD, AUDIO_BATCH_USD_PER_1000_CHARACTERS, readApprovedAudioInputs, runAudioBatch } from './vocabulary-audio-batch-lib';

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, output: { type: 'string' }, run: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    'max-items': { type: 'string' }, 'budget-usd': { type: 'string' }, concurrency: { type: 'string' }, help: { type: 'boolean' },
  }, allowPositionals: false, strict: true });
  if (values.help) {
    console.log(`Approved vocabulary audio builder (default: dry-run, no API calls)

node --conditions=react-server --import tsx scripts/vocabulary-audio-batch.ts \\
  --input artifacts/vocabulary/approved --output artifacts/vocabulary/audio \\
  --dry-run --max-items 7500

Use --run to generate. Inject ELEVENLABS_API_KEY through your secret environment;
do not pass a key as a command argument. --max-items defaults to 1 paid request.
--concurrency defaults to 1 and is limited to 3. A failure stops new waves;
already-started responses finish saving before the worker exits.
--budget-usd can lower the total ledger cap, but cannot exceed USD ${AUDIO_BATCH_BUDGET_USD}.
Reservations use USD ${AUDIO_BATCH_USD_PER_1000_CHARACTERS} per 1000 characters, including failed/uncertain requests.
Existing catalog audio is preserved; ready means verified local audio, existing means
the original cloud asset is referenced without downloading or regenerating it.
Keep --output private and outside public/. The repository's artifacts/ is gitignored.
The builder saves raw responses and never automatically retries a paid request.
After a crash, confirm the worker is stopped before manually removing batch.lock.
This tool does not publish data or change the production app.`);
    return;
  }
  if (!values.input || !values.output) throw new Error('--input and --output are required.');
  if (values.run && values['dry-run']) throw new Error('Choose --run or --dry-run, not both.');
  const entries = await readApprovedAudioInputs(values.input);
  const report = await runAudioBatch({
    entries, output: values.output, run: values.run === true, existingEntries: vocabularyEntries,
    maxItems: values['max-items'] === undefined ? 1 : Number(values['max-items']),
    concurrency: values.concurrency === undefined ? 1 : Number(values.concurrency),
    budgetUsd: values['budget-usd'] === undefined ? AUDIO_BATCH_BUDGET_USD : Number(values['budget-usd']),
    apiKey: values.run ? process.env.ELEVENLABS_API_KEY : undefined,
    onProgress: progress => console.log(JSON.stringify({ event: 'progress', ...progress })),
  });
  console.log(JSON.stringify({ event: 'complete', ...report }, null, 2));
  if (report.stopped || report.failed) process.exitCode = 2;
}
main().catch(error => {
  // Known local validation errors contain no provider response or secret values.
  console.error(error instanceof Error && !('issues' in error) ? error.message : 'The audio batch failed a local integrity check.');
  process.exitCode = 1;
});
