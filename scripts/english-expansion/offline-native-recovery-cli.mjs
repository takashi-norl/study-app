import { parseArgs } from 'node:util';
import { recoverNativeUnits } from './offline-native-recovery.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' }, runtime: { type: 'string' }, proposal: { type: 'string' }, review: { type: 'string' }, root: { type: 'string' }, write: { type: 'boolean' } }, strict: true });
recoverNativeUnits({ output: values.out, runtimeDirectory: values.runtime, proposalPath: values.proposal, reviewPath: values.review, rootApprovalPath: values.root, write: Boolean(values.write) })
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error?.name === 'ZodError' ? 'Recovery evidence failed strict schema validation.' : error.message); process.exitCode = 1; });
