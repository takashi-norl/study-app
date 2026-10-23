import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error; }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temp, path);
}
export async function withLock(output, action) {
  await mkdir(output, { recursive: true });
  const lock = join(output, '.text-build-lock');
  try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error(`Another text build owns ${lock}. After a crashed process, verify it is stopped before removing this directory.`); throw error; }
  try { await atomicJson(join(lock, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() }); return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}
