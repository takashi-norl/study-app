import { prepareOverlaidRecovery, recoverOverlaidUnits } from './offline-overlaid-recovery.mjs';
const args = process.argv.slice(2), mode = args.shift(), options = {};
while (args.length) { const key = args.shift(); if (key === '--write') { options.write = true; continue; }
  const names = { '--id': 'id', '--operation': 'operation', '--output': 'output', '--runtime': 'runtimeDirectory', '--proposal': 'proposalPath', '--review': 'reviewPath', '--authority': 'authorityPath' };
  if (!names[key] || !args.length) throw Error('Unknown or incomplete argument.'); options[names[key]] = args.shift(); }
if (mode === 'prepare') { if (options.write || options.authorityPath) throw Error('Preparation cannot apply an operation.'); console.log(JSON.stringify(await prepareOverlaidRecovery(options), null, 2)); }
else if (mode === 'apply') console.log(JSON.stringify(await recoverOverlaidUnits(options), null, 2));
else throw Error('Use prepare (non-executable draft on stdout) or apply --authority ABSOLUTE_PATH [--write]. No API calls are made.');
