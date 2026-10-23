import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const SPENDING_FENCE_PROTOCOL = 'hibi-shared-spending-v1';
const leases = new WeakSet();
const readOwner = async directory => JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));

/** Phase one holds this for its whole worker lifetime; phase two holds it per pilot action. */
export async function withSharedSpendingFence({ output, sharedLockDirectory, ownerKind }, action) {
  if (![output, sharedLockDirectory].every(value => typeof value === 'string' && isAbsolute(value)) || !['phase-one', 'phase-two'].includes(ownerKind)) throw new Error('Explicit absolute shared fence configuration is required.');
  if (resolve(output) === resolve(sharedLockDirectory) || resolve(output).startsWith(`${resolve(sharedLockDirectory)}/`)) throw new Error('Asset/accounting output must not be inside the disposable lock directory.');
  const owner = Object.freeze({ schemaVersion: 1, protocol: SPENDING_FENCE_PROTOCOL, ownerKind, output: resolve(output), sharedLockDirectory: resolve(sharedLockDirectory), pid: process.pid, nonce: randomUUID(), acquiredAt: new Date().toISOString() });
  await mkdir(dirname(owner.sharedLockDirectory), { recursive: true, mode: 0o700 });
  try { await mkdir(owner.sharedLockDirectory, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Shared spending lock is already held; never clear it automatically.'); throw error; }
  leases.add(owner);
  try {
    const handle = await open(join(owner.sharedLockDirectory, 'owner.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner) + '\n'); await handle.sync(); } finally { await handle.close(); }
    return await action(owner);
  } finally {
    leases.delete(owner);
    let current; try { current = await readOwner(owner.sharedLockDirectory); } catch { /* A missing or damaged owner is left for operator inspection. */ }
    if (current?.nonce === owner.nonce && current.pid === owner.pid) await rm(owner.sharedLockDirectory, { recursive: true });
  }
}
export async function assertSharedSpendingFence(lease, ownerKind = lease?.ownerKind) {
  if (!leases.has(lease) || lease.ownerKind !== ownerKind) throw new Error('A real exclusive shared spending lease is required.');
  const owner = await readOwner(lease.sharedLockDirectory);
  if (owner.protocol !== SPENDING_FENCE_PROTOCOL || owner.nonce !== lease.nonce || owner.pid !== process.pid || owner.ownerKind !== ownerKind || owner.output !== lease.output) throw new Error('Shared spending fence changed ownership.');
}

/** Only a direct child of the holding worker may inherit its phase-one fence. */
export async function assertInheritedPhaseOneFence({ sharedLockDirectory, output, nonce, parentPid = process.ppid }) {
  if (![sharedLockDirectory, output].every(value => typeof value === 'string' && isAbsolute(value)) || !nonce || parentPid !== process.ppid) throw new Error('A direct parent fence is required.');
  const owner = await readOwner(sharedLockDirectory);
  if (owner.protocol !== SPENDING_FENCE_PROTOCOL || owner.ownerKind !== 'phase-one' || owner.nonce !== nonce || owner.pid !== parentPid || owner.output !== resolve(output) || owner.sharedLockDirectory !== resolve(sharedLockDirectory)) throw new Error('Inherited phase-one spending fence does not match its direct parent.');
  return owner;
}
/** Until phase-one reservations use the shared total budget, a handoff is one-way. */
export async function assertPhaseOneNotHandedOff(runtimeDirectory) {
  if (!isAbsolute(runtimeDirectory)) throw new Error('Absolute runtime path required.');
  try { await access(join(runtimeDirectory, 'phase-two-handoff.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Phase two has reserved the shared remainder. Phase-one paid calls are disabled until an explicit shared-budget migration; never delete the handoff automatically.');
}
