import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoundedSourceStream, foldEvents, getSessionSnapshot, studyDataForProfile, type StudyEvent } from '../../src/server/google-store';
import { assertStorageGrant, getAuthConfig, getRegisteredAccounts, getWorkspaceId } from '../../src/server/env';
import { getAuthOptions } from '../../src/server/auth';
import { resolveRegisteredMember } from '../../src/server/beta-membership';
import type { Attempt, Profile, Question } from '../../src/lib/types';

const time = '2026-10-22T00:00:00Z';
const q: Question = { id: 'q', topicId: 't', prompt: 'Original question', choices: ['A', 'B'],
  correctIndex: 0, explanation: 'Private explanation', learningPoint: 'Private learning point',
  sourceIds: ['private-source'], sourceNote: 'Private source text', status: 'published', version: 1,
  createdAt: time, publishedAt: time };
const event = (id: string, type: StudyEvent['type'], payload: StudyEvent['payload']): StudyEvent => ({
  id, type, actorId: 'student', createdAt: time, payload,
});
const session = { id: 's', userId: 'student', mode: 'daily', questionIds: ['q'], createdAt: time, questionSnapshots: [q] };
const answer: Attempt = { id: 'a', userId: 'student', questionId: 'q', questionVersion: 1, sessionId: 's',
  selectedIndex: 1, correct: true, answeredAt: time };
const student: Profile = { id: 'student', workspaceId: getWorkspaceId(), name: '生徒', };

test('event replay and concurrent answer requests preserve one canonical answer and frozen grading', async () => {
  const events = [event('q1', 'question.upserted', q), event('s1', 'session.created', session),
    event('a1', 'attempt.recorded', answer), event('a1', 'attempt.recorded', { ...answer, selectedIndex: 0 }),
    event('a2', 'attempt.recorded', { ...answer, id: 'retry', selectedIndex: 0 }),
    event('q2', 'question.upserted', { ...q, prompt: 'Edited question', correctIndex: 1, version: 2 }),
    event('q3', 'question.upserted', { ...q, prompt: 'Concurrent stale edit', version: 2 })];
  const data = foldEvents(events);
  assert.equal(data.attempts.length, 1);
  assert.equal(data.attempts[0].selectedIndex, 1);
  assert.equal(data.attempts[0].correct, false);
  assert.equal(data.questions[0].prompt, 'Edited question');
  assert.equal(data.sessions[0].completedAt, time);
  const snapshot = await getSessionSnapshot('s', events);
  assert.equal(snapshot[0].prompt, 'Original question');
  assert.equal(snapshot[0].correctIndex, 0);
  snapshot[0].prompt = 'External mutation';
  assert.equal((await getSessionSnapshot('s', events))[0].prompt, 'Original question');
});

test('sessions reject missing or duplicate snapshots; answers cannot cross students or versions', () => {
  assert.throws(() => foldEvents([event('bad', 'session.created', {
    ...session, questionIds: ['q', 'q2'], questionSnapshots: [q, q],
  })]));
  assert.throws(() => foldEvents([event('bad', 'session.created', { ...session, questionSnapshots: [] })]));
  const data = foldEvents([event('s', 'session.created', session),
    event('wrong-user', 'attempt.recorded', { ...answer, userId: 'someone-else' }),
    event('wrong-version', 'attempt.recorded', { ...answer, questionVersion: 2 }),
    event('out-of-range', 'attempt.recorded', { ...answer, selectedIndex: 2 })]);
  assert.equal(data.attempts.length, 0);
  assert.equal(data.sessions[0].completedAt, undefined);
});

test('a session completes only after every question has a canonical answer, using the latest answer time', () => {
  const second = { ...q, id: 'q2' };
  const events = [event('s', 'session.created', { ...session, questionIds: ['q', 'q2'], questionSnapshots: [q, second] }),
    event('a1', 'attempt.recorded', answer)];
  assert.equal(foldEvents(events).sessions[0].completedAt, undefined);
  events.push(event('a2', 'attempt.recorded', { ...answer, id: 'a2', questionId: 'q2', answeredAt: '2026-10-22T00:05:00Z' }));
  assert.equal(foldEvents(events).sessions[0].completedAt, '2026-10-22T00:05:00Z');
  events.push(event('duplicate-answer', 'attempt.recorded', { ...answer, answeredAt: '2026-10-22T00:10:00Z' }));
  assert.equal(foldEvents(events).sessions[0].completedAt, '2026-10-22T00:05:00Z');
});

test('different workspaces are rejected and duplicate exposure rows do not increase coverage', () => {
  assert.throws(() => foldEvents([{ ...event('q', 'question.upserted', q), workspaceId: 'another-workspace' }]));
  const exposure = { id: 'seen', userId: 'student', questionId: 'q', questionVersion: 1, sessionId: 's', shownAt: time };
  const data = foldEvents([event('s', 'session.created', session), event('seen1', 'exposure.recorded', exposure),
    event('seen2', 'exposure.recorded', { ...exposure, id: 'new-request' })]);
  assert.equal(data.exposures.length, 1);
  assert.throws(() => studyDataForProfile(data, { ...student, workspaceId: 'another-workspace' }));
});

test('owner authoring retains answers while hiding foreign sources, frozen snapshots and other users records', () => {
  const data = foldEvents([event('q', 'question.upserted', q), event('s', 'session.created', session),
    event('a', 'attempt.recorded', answer),
    event('draft', 'question.upserted', { ...q, id: 'draft', status: 'draft' }),
    event('future', 'question.upserted', { ...q, id: 'future', publishedAt: '2026-10-23T00:00:00Z' }),
    event('unscheduled', 'question.upserted', { ...q, id: 'unscheduled', publishedAt: undefined }),
    event('visible-topic', 'topic.created', { id: 't', title: '公開トピック', subject: '古文', description: '', createdAt: time, targetCount: 10 }),
    event('hidden-topic', 'topic.created', { id: 'hidden', title: '準備中トピック', subject: '古文', description: '', createdAt: time, targetCount: 10 }),
    event('source', 'source.created', { id: 'private-source', topicId: 't', name: 'Private file', mimeType: 'image/jpeg', storagePath: 'drive-file-id', createdAt: time }),
    event('other-session', 'session.created', { ...session, id: 'other-session', userId: 'another-student' }),
    event('other-answer', 'attempt.recorded', { ...answer, id: 'other-answer', sessionId: 'other-session', userId: 'another-student' }),
  ]);
  // Even accidental inclusion of the server-only field must not survive the public projection.
  Object.assign(data.sessions[0], { questionSnapshots: [q] });
  const projected = studyDataForProfile(data, student, new Date(time));
  assert.equal(projected.questions.length, 4); // All saved own private questions are immediately usable.
  assert.equal(projected.topics.length, 2); // Own empty sets remain navigable.
  assert.equal(projected.topics[0].id, 't');
  assert.equal(projected.questions[0].correctIndex, 0);
  assert.equal(projected.questions[0].explanation, q.explanation);
  assert.equal(projected.questions[0].sourceNote, q.sourceNote);
  assert.deepEqual(projected.questions[0].sourceIds, []);
  assert.equal(projected.sources.length, 0);
  assert.equal(projected.jobs.length, 0);
  assert.equal(projected.sessions.length, 1);
  assert.equal(projected.attempts.length, 1);
  assert.equal(JSON.stringify(projected).includes('questionSnapshots'), false);
  assert.equal(JSON.stringify(projected.sources).includes('Private source'), false);
  assert.equal(data.questions[0].correctIndex, 0);
});

test('missing, empty, duplicate and malformed account configuration fails closed', () => {
  const oldValue = process.env.REGISTERED_ACCOUNTS_JSON;
  try {
    delete process.env.REGISTERED_ACCOUNTS_JSON;
    assert.throws(() => getRegisteredAccounts());
    for (const invalid of ['[]', '{bad json}', '[{"id":"student","email":"not-an-email","name":"s"}]']) {
      process.env.REGISTERED_ACCOUNTS_JSON = invalid;
      assert.throws(() => getRegisteredAccounts());
    }
    const operator = { id: 'operator', email: 'OPERATOR@example.com', name: '利用者', };
    process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify([operator]);
    assert.equal(getRegisteredAccounts()[0].email, 'operator@example.com');
    process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify([operator, { ...operator, id: 'another-operator', email: 'operator@example.com' }]);
    assert.throws(() => getRegisteredAccounts());
  } finally {
    if (oldValue === undefined) delete process.env.REGISTERED_ACCOUNTS_JSON;
    else process.env.REGISTERED_ACCOUNTS_JSON = oldValue;
  }
});

test('missing or weak auth secrets cannot enable login', () => {
  const oldValue = process.env.NEXTAUTH_SECRET;
  try {
    delete process.env.NEXTAUTH_SECRET;
    assert.throws(() => getAuthConfig());
    process.env.NEXTAUTH_SECRET = 'short';
    assert.throws(() => getAuthConfig());
  } finally {
    if (oldValue === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = oldValue;
  }
});

test('storage tokens require the intended app, minimal Drive scope and configured verified owner', () => {
  const config = { clientId: 'configured-client', ownerEmail: 'owner@example.com' };
  const grant = { aud: config.clientId, scopes: ['https://www.googleapis.com/auth/drive.file', 'openid', 'https://www.googleapis.com/auth/userinfo.email'],
    email: config.ownerEmail, email_verified: true };
  assert.doesNotThrow(() => assertStorageGrant(grant, config));
  assert.doesNotThrow(() => assertStorageGrant({ ...grant, email_verified: 'true' }, config));
  assert.throws(() => assertStorageGrant({ ...grant, aud: 'unrelated-client' }, config));
  assert.throws(() => assertStorageGrant({ ...grant, scopes: ['https://www.googleapis.com/auth/drive'] }, config));
  assert.throws(() => assertStorageGrant({ ...grant, scopes: [...grant.scopes, 'https://www.googleapis.com/auth/spreadsheets'] }, config));
  assert.throws(() => assertStorageGrant({ ...grant, email: 'different@example.com' }, config));
  assert.throws(() => assertStorageGrant({ ...grant, email_verified: false }, config));
  assert.throws(() => assertStorageGrant({ ...grant, email_verified: 'false' }, config));
});

test('source streaming supports bodies above 4.5 MB and rejects oversized or truncated transfers', async () => {
  const total = 5 * 1024 * 1024;
  const upstream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(total)); controller.close();
  } });
  const valid = createBoundedSourceStream(upstream, total);
  const reader = valid.getReader();
  assert.equal((await reader.read()).value!.byteLength, total);
  assert.equal((await reader.read()).done, true);
  let cancelled = false;
  const excess = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(4)); },
    cancel() { cancelled = true; } });
  const bounded = createBoundedSourceStream(excess, 3).getReader();
  await assert.rejects(bounded.read(), /サイズ/);
  assert.equal(cancelled, true);
  const short = createBoundedSourceStream(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), 3).getReader();
  await assert.rejects(short.read(), /途中/);
  assert.throws(() => createBoundedSourceStream(new ReadableStream(), 10 * 1024 * 1024 + 1));
});

test('source stream does not eagerly drain Drive and propagates browser cancellation', async () => {
  let pulls = 0;
  let cancelled: unknown;
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1)); },
    cancel(reason) { cancelled = reason; },
  });
  const bounded = createBoundedSourceStream(upstream, 1000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(pulls <= 2, 'Only the bounded and upstream stream queues may prefetch');
  await bounded.cancel('browser-disconnected');
  assert.equal(cancelled, 'browser-disconnected');
});

test('Google login requires a verified allowlisted email and a removed member loses session authorization', async () => {
  const keys = ['NEXTAUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'REGISTERED_ACCOUNTS_JSON'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const operator = { id: 'operator', email: 'operator@example.com', name: '利用者', };
  const child = { id: 'student', email: 'child@example.com', name: '生徒', };
  try {
    process.env.NEXTAUTH_SECRET = 'test-only-secret-with-at-least-thirty-two-characters';
    process.env.GOOGLE_CLIENT_ID = 'test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify([operator, child]);
    const callbacks = getAuthOptions({ resolveMember: (email, subject) => resolveRegisteredMember(email, subject, { load: async () => [] }) }).callbacks!;
    const signIn = callbacks.signIn!;
    const args = { user: { id: 'google-subject' }, account: { provider: 'google', type: 'oauth' as const, providerAccountId: 'google-subject' } };
    assert.equal(await signIn({ ...args, profile: { email: child.email, email_verified: false } as any }), false);
    assert.equal(await signIn({ ...args, profile: { email: 'stranger@example.com', email_verified: true } as any }), false);
    assert.equal(await signIn({ ...args, profile: { email: child.email, email_verified: true } as any }), true);
    const session = { expires: time, user: { name: '', email: child.email } };
    const token = { email: child.email, googleVerified: true };
    const authorized = await callbacks.session!({ session, token, user: { id: '' } } as any);
    assert.equal((authorized as any).profile.id, 'student');
    process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify([operator]);
    const revoked = await callbacks.session!({ session, token, user: { id: '' } } as any);
    assert.equal((revoked as any).profile, undefined);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
