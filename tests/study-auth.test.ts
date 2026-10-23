import assert from 'node:assert/strict';
import test from 'node:test';
import { checkStudyAccess, isStudyStatePayload, sameStudyIdentity, studyAccessFailure, type StudyStatePayload } from '../src/lib/study-auth';
import type { Profile } from '../src/lib/types';

const profile: Profile = { id: 'learner', familyId: 'family', name: '本人', role: 'student', accessLevel: 'learner' };
function state(): StudyStatePayload {
  return { profile, data: { topics: [], sources: [], questions: [], attempts: [], exposures: [], sessions: [], jobs: [], profiles: [profile], plans: [], planningTurns: [] } };
}

test('startup renews the session before loading authorized study data', async () => {
  const calls: string[] = [];
  const result = await checkStudyAccess(async () => {
    calls.push('session'); return { status: 'authenticated', profile };
  }, async currentProfile => {
    calls.push('state'); assert.deepEqual(currentProfile, profile); return state();
  });
  assert.deepEqual(calls, ['session', 'state']);
  assert.deepEqual(result, { status: 'authenticated', ...state() });
});

test('an unavailable session produces a retry state and never fetches study data or pretends to log out', async () => {
  let read = false;
  const unavailable = { status: 'unavailable' as const, message: '接続を再確認してください。' };
  assert.deepEqual(await checkStudyAccess(async () => unavailable, async () => { read = true; return state(); }), unavailable);
  assert.equal(read, false);
  const thrown = await checkStudyAccess(async () => { throw new TypeError('network failure'); }, async () => { read = true; return state(); });
  assert.equal(thrown.status, 'unavailable');
  assert.equal(read, false);
});

test('storage timeout, network/server failure and malformed state keep the recovery path instead of showing Login', async () => {
  for (const failure of [new TypeError('network'), new DOMException('timeout', 'AbortError'), Object.assign(new Error('storage busy'), { status: 503 })]) {
    assert.equal((await checkStudyAccess(async () => ({ status: 'authenticated', profile }), async () => { throw failure; })).status, 'unavailable');
    assert.equal(studyAccessFailure(failure).status, 'unavailable');
  }
  for (const malformed of [null, { error: 'state unavailable' }, { ...state(), data: {} }, { ...state(), profile: { ...profile, role: 'admin' } }]) {
    assert.equal(isStudyStatePayload(malformed), false);
    assert.equal((await checkStudyAccess(async () => ({ status: 'authenticated', profile }), async () => malformed)).status, 'unavailable');
  }
});

test('missing session and membership revoked between session and state both require login', async () => {
  let read = false;
  assert.deepEqual(await checkStudyAccess(async () => ({ status: 'unauthenticated' }), async () => { read = true; return state(); }), { status: 'unauthenticated' });
  assert.equal(read, false);
  const revoked = Object.assign(new Error('no longer a member'), { status: 401 });
  assert.deepEqual(await checkStudyAccess(async () => ({ status: 'authenticated', profile }), async () => { throw revoked; }), { status: 'unauthenticated' });
  assert.deepEqual(studyAccessFailure(revoked), { status: 'unauthenticated' });
  assert.equal(studyAccessFailure(Object.assign(new Error('forbidden action'), { status: 403 })).status, 'unavailable');
});

test('changing identity or privileges never combines the old session with a different private state', async () => {
  for (const changed of [{ ...profile, id: 'other' }, { ...profile, familyId: 'other-family' },
    { ...profile, role: 'parent' as const }, { ...profile, accessLevel: 'manager' as const }]) {
    assert.equal(sameStudyIdentity(profile, changed), false);
    const result = await checkStudyAccess(async () => ({ status: 'authenticated', profile }), async () => ({ ...state(), profile: changed }));
    assert.equal(result.status, 'unavailable');
    if(result.status==='unavailable')assert.equal(result.identityChanged, true, 'the previous private screen must be cleared');
  }
  assert.equal(sameStudyIdentity(profile, { ...profile, name: '更新された名前' }), true);
});
