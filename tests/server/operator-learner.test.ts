import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import type { Session } from 'next-auth';
import { getAuthOptions } from '../../src/server/auth';
import { resolveRegisteredMember } from '../../src/server/beta-membership';
import { assertSuperUser, getRegisteredAccounts, profileForAccount } from '../../src/server/env';
import { foldEvents, studyDataForProfile, type StudyEvent } from '../../src/server/google-store';
import { assertOwnQuestion } from '../../src/server/access';
import { assertPracticeTopic, mayPracticeQuestion } from '../../src/server/practice-access';
import { assertGenerationAccess, generationReplay } from '../../src/server/proposal-selection';
import { prepareGenerationRetry } from '../../src/server/generation-retry';

const keys = ['REGISTERED_ACCOUNTS_JSON', 'WORKSPACE_ID', 'NEXTAUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const members = [
  { id: 'existing-operator-id', name: 'Takashi', email: 'takashi.oikawa@gmail.com', },
  { id: 'legacy-operator', name: 'Legacy member', email: 'legacy@example.com', },
  { id: 'learner', name: 'Learner', email: 'learner@example.com', },
];
const now = '2026-10-24T00:00:00.000Z';
beforeEach(() => {
  process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify(members);
  process.env.WORKSPACE_ID = 'operator-learner-test';
  process.env.NEXTAUTH_SECRET = 'test-only-secret-at-least-thirty-two-characters';
  process.env.GOOGLE_CLIENT_ID = 'test-client';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
});
afterEach(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

function fixture() {
  const profiles = getRegisteredAccounts().map(profileForAccount);
  const events: StudyEvent[] = [profiles[0], profiles[2]].flatMap(person => {
    const id = person.id;
    const event = (type: StudyEvent['type'], payload: unknown): StudyEvent => ({ id: `${id}:${type}`, actorId: id, type, createdAt: now, payload });
    const question = { id: `question-${id}`, topicId: `topic-${id}`, ownerId: id, prompt: '文中の「いと」の意味は。',
      choices: ['とても', '少し', 'やがて', '決して'], correctIndex: 0, explanation: '「いと」は程度が強いことを表します。',
      learningPoint: '古文単語｜いと', sourceIds: [`source-${id}`], sourceNote: '自分の教材', status: 'published', version: 1, createdAt: now };
    return [
      event('source.created', { id: `source-${id}`, ownerId: id, name: '教材.jpg', mimeType: 'image/jpeg', storagePath: `file-${id}`, createdAt: now }),
      event('plan.created', { id: `plan-${id}`, ownerId: id, title: '古文', subject: '古文', goal: '意味を覚える', difficulty: '標準', dailyQuestionTarget: 10, sourceIds: [`source-${id}`], version: 1, createdAt: now, updatedAt: now }),
      event('topic.created', { id: question.topicId, ownerId: id, planId: `plan-${id}`, title: '古文の確認', subject: '古文', description: '', targetCount: 10, createdAt: now }),
      event('question.upserted', question),
      event('job.upserted', { id: `job-${id}`, topicId: question.topicId, planId: `plan-${id}`, requestedBy: id, requestId: `request-${id}`, sourceIds: [`source-${id}`], status: 'failed', targetCount: 10, generatedCount: 1, createdAt: now }),
      event('session.created', { id: `session-${id}`, userId: id, mode: 'daily', questionIds: [question.id], questionSnapshots: [question], createdAt: now }),
      event('attempt.recorded', { id: `attempt-${id}`, userId: id, sessionId: `session-${id}`, questionId: question.id, questionVersion: 1, selectedIndex: 0, correct: true, answeredAt: now }),
      event('exposure.recorded', { id: `exposure-${id}`, userId: id, sessionId: `session-${id}`, questionId: question.id, questionVersion: 1, shownAt: now }),
    ];
  });
  return { profiles, events, data: foldEvents(events, profiles) };
}

test('all accounts are learners with stable IDs and only the configured operator receives administrative capability', () => {
  const raw = getRegisteredAccounts(), profiles = raw.map(profileForAccount);
  assert.deepEqual(raw[0], members[0]);
  assert.deepEqual(profiles[0], { id: members[0].id, name: members[0].name,  accessLevel: 'superuser', workspaceId: 'operator-learner-test' });
  assert.equal(profiles[1].accessLevel, 'learner');
  assert.equal(assertSuperUser(profiles[0]).id, members[0].id);
  for (const profile of profiles.slice(1)) {
    assert.throws(() => assertSuperUser({ ...profile,  accessLevel: 'superuser' }), { code: 'FORBIDDEN' });
  }
  assert.throws(() => assertSuperUser({ ...profiles[0], workspaceId: 'another-app' }), { code: 'FORBIDDEN' });
  process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify(members.slice(1));
  assert.throws(() => assertSuperUser(profiles[0]), { code: 'FORBIDDEN' }, 'removal takes effect for an old profile');
});

test('verified Google sessions expose the current learner profile and reject unverified or forged identity', async () => {
  const callbacks = getAuthOptions({ resolveMember: (email, subject) => resolveRegisteredMember(email, subject, { load: async () => [] }) }).callbacks!;
  const account = { provider: 'google', providerAccountId: 'operator-google-subject' };
  const googleProfile = { email: members[0].email, email_verified: true, sub: account.providerAccountId };
  assert.equal(await callbacks.signIn!({ account, profile: googleProfile } as any), true);
  assert.equal(await callbacks.signIn!({ account, profile: { ...googleProfile, email_verified: false } } as any), false);
  assert.equal(await callbacks.signIn!({ account: { ...account, provider: 'other' }, profile: googleProfile } as any), false);
  const stale = { ...profileForAccount(members[0]), role: 'obsolete' };
  const session = () => ({ expires: '2026-11-24T00:00:00Z', profile: stale, user: { email: members[0].email } });
  const verified = await callbacks.session!({ session: session(), token: { email: members[0].email, googleVerified: true }, user: { id: '' } } as any) as Session;
  assert.equal(verified.profile?.id, members[0].id);
  assert.equal('role' in verified.profile!, false);
  assert.equal(assertSuperUser(verified.profile!).accessLevel, 'superuser');
  const unverified = await callbacks.session!({ session: session(), token: { email: members[0].email, googleVerified: false }, user: { id: '' } } as any) as Session;
  assert.equal(unverified.profile, undefined, 'a stale/client profile cannot establish identity');
  const differentAccount = await callbacks.session!({ session: session(), token: { email: members[2].email, googleVerified: true }, user: { id: '' } } as any) as Session;
  assert.equal(differentAccount.profile?.id, members[2].id);
  assert.throws(() => assertSuperUser(differentAccount.profile!), { code: 'FORBIDDEN' });
});

test('existing operator-owned materials and progress remain visible and playable while every other learner stays private', () => {
  const { profiles, data } = fixture(), operator = profiles[0], before = structuredClone(data);
  const visible = studyDataForProfile(data, operator);
  for (const key of ['topics', 'questions', 'sources', 'plans', 'jobs', 'attempts', 'exposures', 'sessions', 'profiles'] as const) assert.equal(visible[key].length, 1, key);
  assert.equal(visible.questions[0].id, `question-${operator.id}`);
  assert.equal(visible.questions[0].correctIndex, 0);
  assert.equal(visible.attempts[0].id, `attempt-${operator.id}`);
  assert.equal('role' in visible.profiles[0], false);
  assert.doesNotThrow(() => assertPracticeTopic(data, operator, visible.topics[0].id));
  assert.equal(mayPracticeQuestion(data, operator, visible.questions[0]), true);
  assert.throws(() => assertOwnQuestion(data, operator, 'question-learner'), { code: 'QUESTION_NOT_FOUND' });
  assert.throws(() => assertOwnQuestion(data, profiles[2], visible.questions[0].id), { code: 'QUESTION_NOT_FOUND' });
  assert.deepEqual(data, before, 'projecting an account does not migrate or rewrite study data');
});

test('the verified operator can resume a personal legacy job without an audience and retry with its unchanged scope', () => {
  const { profiles, data } = fixture(), operator = profiles[0], job = data.jobs[0];
  assert.equal(job.audienceUserId, undefined);
  assert.equal(assertGenerationAccess(data, job).id, operator.id);
  assert.equal(generationReplay(data, operator, { requestId: job.requestId, planId: job.planId })?.job.id, job.id);
  const retry = prepareGenerationRetry(data, operator, job.id, 'retry-request', new Date(now), 'retry-job');
  assert.equal(retry.job.requestedBy, operator.id);
  assert.equal(retry.job.planId, job.planId);
  assert.equal(retry.job.audienceUserId, undefined);
  assert.deepEqual(retry.job.sourceIds, job.sourceIds);
});

test('the legacy-job exception grants no cross-user access and rechecks the actual operator allowlist', () => {
  const { profiles, data } = fixture(), operator = profiles[0], job = data.jobs[0];
  for (const changed of [
    { ...data, topics: data.topics.map(topic => topic.id === job.topicId ? { ...topic, ownerId: 'learner' } : topic) },
    { ...data, plans: data.plans.map(plan => plan.id === job.planId ? { ...plan, ownerId: 'learner' } : plan) },
    { ...data, sources: data.sources.map(source => job.sourceIds?.includes(source.id) ? { ...source, ownerId: 'learner' } : source) },
    { ...data, profiles: profiles.filter(profile => profile.id !== operator.id) },
  ]) assert.throws(() => assertGenerationAccess(changed, job), { code: 'GENERATION_ACCESS_DENIED' });
  const foreignAudience = { ...data, topics: data.topics.map(topic => topic.id === job.topicId ? { ...topic, audienceUserId: 'learner' } : topic) };
  assert.throws(() => assertGenerationAccess(foreignAudience, { ...job, audienceUserId: 'learner' }), { code: 'GENERATION_ACCESS_DENIED' });
  const ordinaryJob = data.jobs[1];
  assert.throws(() => assertGenerationAccess(data, ordinaryJob), { code: 'GENERATION_ACCESS_DENIED' });
  const spoofed = { ...data, profiles: profiles.map(profile => profile.id === 'learner' ? { ...profile, accessLevel: 'superuser' as const } : profile) };
  assert.throws(() => assertGenerationAccess(spoofed, ordinaryJob), { code: 'FORBIDDEN' });
  process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify(members.slice(1));
  assert.throws(() => assertGenerationAccess(data, job), { code: 'FORBIDDEN' });
});
