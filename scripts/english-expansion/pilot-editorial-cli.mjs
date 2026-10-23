import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyIntegration } from './activation.mjs';
import { applyEditorialOverlay, inspectEditorialOverlay } from './pilot-editorial.mjs';
import { withExpansionLock } from './store.mjs';

/** Offline only: this module has no provider/credential access or spending operation. */
export async function runEditorialOverlay(options) {
  return withExpansionLock(options, async lease => {
    const { config } = await verifyIntegration(options);
    if (!config.pilotEditorial) throw new Error('The installed integration receipt has no explicit editorial authority.');
    return options.write
      ? applyEditorialOverlay(lease, config.pilotRepair, config.pilotEditorial)
      : (await inspectEditorialOverlay(lease.output, config.pilotRepair, config.pilotEditorial, { requirePersisted: false })).record;
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = {}, names = { '--out': 'output', '--phase-one': 'phaseOneOutput', '--runtime': 'runtimeDirectory' };
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--write' && !options.write) { options.write = true; continue; }
      const key = names[args[i]]; if (!key || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown, duplicated or incomplete CLI argument.');
      options[key] = args[++i];
    }
    if (Object.values(names).some(key => !options[key])) throw new Error('Explicit --out, --phase-one and --runtime are required.');
    options.sharedLockDirectory = join(options.runtimeDirectory, 'shared-spending.lock');
    const result = await runEditorialOverlay(options);
    process.stdout.write(JSON.stringify({ dryRun: !options.write, ...result }) + '\n');
  } catch (error) {
    process.stderr.write(`Editorial overlay stopped: ${error?.name === 'ZodError' ? 'Private authority failed strict schema validation.' : error.message}\n`);
    process.exitCode = 1;
  }
}
