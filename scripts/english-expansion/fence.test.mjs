import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { withSharedSpendingFence, assertSharedSpendingFence, assertPhaseOneNotHandedOff } from '../shared-spending-fence.mjs';
const child = (code, cwd) => new Promise(resolve => { const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code], { cwd, stdio: 'pipe' }); let stderr = ''; process.stderr.on('data', data => { stderr += data; }); process.on('close', status => resolve({ status, stderr })); });
test('only direct children with exact owner nonce can inherit a phase-one lifetime lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-fence-test-'));
  try {
    const options = { output: join(root, 'base'), sharedLockDirectory: join(root, 'shared-spending.lock'), ownerKind: 'phase-one' };
    await assert.rejects(withSharedSpendingFence({ ...options, output: join(options.sharedLockDirectory, 'assets') }, () => {}), /disposable lock/);
    await withSharedSpendingFence(options, async lease => {
      await assertSharedSpendingFence(lease, 'phase-one');
      const module = new URL('../shared-spending-fence.mjs', import.meta.url).href;
      const probe = nonce => `import { assertInheritedPhaseOneFence } from ${JSON.stringify(module)}; await assertInheritedPhaseOneFence(${JSON.stringify({ sharedLockDirectory: options.sharedLockDirectory, output: options.output, nonce })});`;
      assert.equal((await child(probe(lease.nonce), root)).status, 0);
      assert.notEqual((await child(probe('forged'), root)).status, 0);
      await assert.rejects(assertSharedSpendingFence({ ...lease }), /real exclusive/);
    });
    await withSharedSpendingFence(options, () => {});
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('damaged ownership and a durable phase-two handoff are never cleared automatically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-fence-test-'));
  try {
    await assertPhaseOneNotHandedOff(root);
    await writeFile(join(root, 'phase-two-handoff.json'), 'even damaged evidence must stop phase one');
    await assert.rejects(assertPhaseOneNotHandedOff(root), /Phase two has reserved/);
    const options = { output: join(root, 'base'), sharedLockDirectory: join(root, 'shared-spending.lock'), ownerKind: 'phase-one' };
    await withSharedSpendingFence(options, async () => { await writeFile(join(options.sharedLockDirectory, 'owner.json'), '{}'); });
    assert.equal(await readFile(join(options.sharedLockDirectory, 'owner.json'), 'utf8'), '{}');
    await assert.rejects(withSharedSpendingFence(options, () => {}), /already held/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
