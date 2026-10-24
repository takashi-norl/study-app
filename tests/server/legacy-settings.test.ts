import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { getRegisteredAccounts, getWorkspaceId, profileForAccount } from '../../src/server/env';
import { foldEvents, type StudyEvent } from '../../src/server/google-store';
import { paidWorkSlotId } from '../../src/server/planning';

// Old deployment keys are exercised only here; application code uses the canonical workspace names.
const keys = ['WORKSPACE_ID', 'REGISTERED_ACCOUNTS_JSON', 'FAMILY_ID', 'ALLOWED_FAMILY_MEMBERS_JSON'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
beforeEach(() => { for (const key of keys) delete process.env[key]; });
afterEach(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
const account = { id: 'existing-account-id', email: 'learner@example.com', name: 'Learner' };

test('existing deployment settings retain workspace and account IDs while obsolete account fields grant nothing', () => {
  process.env.FAMILY_ID = 'existing-workspace-id';
  process.env.ALLOWED_FAMILY_MEMBERS_JSON = JSON.stringify([{ ...account, role: 'removed-role', accessLevel: 'superuser' }]);
  assert.equal(getWorkspaceId(), 'existing-workspace-id');
  assert.deepEqual(getRegisteredAccounts(), [account]);
  assert.deepEqual(profileForAccount(getRegisteredAccounts()[0]), { id: account.id, name: account.name, workspaceId: 'existing-workspace-id', accessLevel: 'learner' });
  const event: StudyEvent = { id: 'existing-event', type: 'topic.created', actorId: account.id, workspaceId: getWorkspaceId(), createdAt: '2026-10-24T00:00:00Z',
    payload: { id: 'existing-topic', ownerId: account.id, title: '本人の問題集', subject: '古文', description: '', targetCount: 10, createdAt: '2026-10-24T00:00:00Z' } };
  assert.equal(foldEvents([event]).topics[0].id, 'existing-topic');
  assert.throws(() => foldEvents([{ ...event, workspaceId: 'foreign-workspace' }]), { code: 'WORKSPACE_MISMATCH' });
});

test('canonical settings win and an invalid canonical allowlist cannot silently fall back', () => {
  process.env.FAMILY_ID = 'old-workspace';
  process.env.ALLOWED_FAMILY_MEMBERS_JSON = JSON.stringify([account]);
  process.env.WORKSPACE_ID = 'current-workspace';
  const replacement = { ...account, id: 'current-account-id', email: 'current@example.com' };
  process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify([replacement]);
  assert.equal(getWorkspaceId(), 'current-workspace');
  assert.deepEqual(getRegisteredAccounts(), [replacement]);
  for (const invalid of ['', '[]', 'not-json']) {
    process.env.REGISTERED_ACCOUNTS_JSON = invalid;
    assert.throws(() => getRegisteredAccounts(), { code: 'INVALID_ACCOUNT_CONFIG' });
  }
});

test('a learner-only allowlist is valid and duplicate IDs or normalized emails still fail closed', () => {
  process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify([account]);
  assert.deepEqual(getRegisteredAccounts(), [account]);
  for (const duplicate of [{ ...account, email: 'another@example.com' }, { ...account, id: 'another', email: 'LEARNER@example.com' }]) {
    process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify([account, duplicate]);
    assert.throws(() => getRegisteredAccounts(), { code: 'INVALID_ACCOUNT_CONFIG' });
  }
});

test('the original default namespace and paid-work keys remain byte-for-byte compatible', () => {
  assert.equal(getWorkspaceId(), 'family-primary');
  assert.equal(paidWorkSlotId({ jobs: [], planningTurns: [] }), 'family-paid-slot:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
});
