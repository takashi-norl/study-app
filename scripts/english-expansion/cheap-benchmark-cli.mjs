import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { readJson } from './store.mjs';
import { dispatchCheapBenchmark } from './cheap-benchmark.mjs';
try {
  const { values } = parseArgs({ options: { out: { type: 'string' }, base: { type: 'string' }, runtime: { type: 'string' }, authority: { type: 'string' }, work: { type: 'string' }, 'review-authority': { type: 'string' }, send: { type: 'boolean', default: false } }, strict: true });
  for (const key of ['out', 'base', 'runtime', 'authority', 'work']) if (!values[key]) throw Error('Missing required explicit path.');
  const result = await dispatchCheapBenchmark({ output: values.out, phaseOneOutput: values.base, runtimeDirectory: values.runtime,
    sharedLockDirectory: join(values.runtime, 'shared-spending.lock'), authorityPath: values.authority, work: await readJson(values.work),
    reviewAuthorityPath: values['review-authority'], send: values.send });
  console.log(JSON.stringify(result));
} catch { console.error('Benchmark stopped. Inspect local authority, settled ledger and saved response evidence; no automatic retry was attempted.'); process.exitCode = 1; }
