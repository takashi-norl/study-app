#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Keep the existing CLI while sharing the application's exact TypeScript audio identity.
const loader = createRequire(import.meta.url).resolve('tsx');
const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', loader,
  fileURLToPath(new URL('./vocabulary-catalog-export-runner.mjs', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) { console.error('Could not start the local vocabulary exporter.'); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
