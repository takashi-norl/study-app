import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { priceAnthropicUsage, summarizeAiUsage, summarizeOperationalAiUsage, trackedAnthropicMessage } from '../../src/server/ai-usage';
import { aiRequestedSchema, aiUsageSchema } from '../../src/server/ai-usage-schema';
import { assertSuperUser, getFamilyId, getFamilyMembers, profileForMember } from '../../src/server/env';
import { getAuthOptions } from '../../src/server/auth';
import { foldEvents, studyDataForProfile, type StudyEvent } from '../../src/server/google-store';
import { ApiError } from '../../src/server/config';

const model = 'claude-sonnet-4-6';
const usage = { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 300,
  cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } };
const response = { id: 'msg_sample', model, content: [], stop_reason: 'max_tokens', usage } as unknown as Anthropic.Messages.Message;
const params: Anthropic.Messages.MessageCreateParamsNonStreaming = { model, max_tokens: 100, messages: [{ role: 'user', content: 'PRIVATE PROMPT MUST NEVER BE LOGGED' }] };
const context = { actorId: 'student', feature: 'profile' as const, requestId: 'logical-request' };
const members = [{ id: 'super', email: 'takashi.oikawa@gmail.com', role: 'parent' as const, name: 'Takashi' },
  { id: 'manager', email: 'leo.oikawa55@gmail.com', role: 'parent' as const, name: 'Leo' },
  { id: 'student', email: 'yusei.oikawa@gmail.com', role: 'student' as const, name: 'Yusei' }];

test('standard Claude estimate counts input, output, cache reads and both cache write durations separately', () => {
  const priced = priceAnthropicUsage(model, usage);
  assert.equal(priced.estimatedUsd, 0.007725);
  assert.equal(priced.unknownReason, null);
  assert.equal(priced.inputTokens, 1000);
  assert.equal(priced.cacheWrite5mTokens, 100);
  assert.equal(priced.cacheWrite1hTokens, 200);
  assert.equal(priceAnthropicUsage(model, { ...usage, inference_geo: 'us' }).estimatedUsd, 0.0084975);
});

test('unknown models, missing counts, unspecified cache duration and unsupported billing never become a zero estimate', () => {
  for (const [candidateModel, candidateUsage, reason] of [
    ['future-model', usage, 'unknown-model'],
    ['constructor', usage, 'unknown-model'],
    [model, null, 'usage-unavailable'],
    [model, { input_tokens: 0 }, 'usage-unavailable'],
    [model, { ...usage, cache_creation: null }, 'cache-duration-unknown'],
    [model, { ...usage, speed: 'fast' }, 'unsupported-billing'],
    [model, { ...usage, service_tier: 'priority' }, 'unsupported-billing'],
  ] as const) {
    const result = priceAnthropicUsage(candidateModel, candidateUsage);
    assert.equal(result.estimatedUsd, null);
    assert.equal(result.unknownReason, reason);
  }
  assert.equal(priceAnthropicUsage(model, { input_tokens: 0, output_tokens: 0 }).estimatedUsd, 0);
});

test('usage is durably recorded before output validation; no raw prompt or response text enters the ledger', async () => {
  const events: StudyEvent[] = [];
  const result = await trackedAnthropicMessage(context, params, {
    append: async event => { events.push(event); },
    create: async () => {
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'ai.requested');
      return response;
    },
  });
  assert.equal(result.stop_reason, 'max_tokens');
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'ai.usage');
  assert.equal(events[1].payload.estimatedUsd, 0.007725);
  assert.equal(JSON.stringify(events).includes('PRIVATE PROMPT'), false);
  assert.equal(JSON.stringify(events).includes('content'), false);
  assert.doesNotThrow(() => aiRequestedSchema.parse(events[0].payload));
  assert.doesNotThrow(() => aiUsageSchema.parse(events[1].payload));
});

test('failed calls are unknown charges, append failure prevents spending, and missing usage stays unresolved', async () => {
  const events: StudyEvent[] = [];
  let calls = 0;
  const error = new Error('network timeout may have reached provider');
  await assert.rejects(trackedAnthropicMessage(context, params, {
    append: async event => { events.push(event); }, create: async () => { calls++; throw error; },
  }), error);
  assert.equal(calls, 1);
  assert.equal(events[1].payload.status, 'failed');
  assert.equal(events[1].payload.estimatedUsd, null);
  await assert.rejects(trackedAnthropicMessage(context, params, {
    append: async () => { throw new Error('receipt store down'); }, create: async () => { calls++; return response; },
  }));
  assert.equal(calls, 1);
  const unresolved: StudyEvent[] = [];
  await assert.rejects(trackedAnthropicMessage(context, params, {
    append: async event => { if (event.type === 'ai.usage') throw new Error('result store down'); unresolved.push(event); },
    create: async () => response,
  }), (error: unknown) => error instanceof ApiError && error.code === 'AI_RECORD_FAILED');
  const summary = summarizeAiUsage([...events, ...unresolved], members.map(profileForMember));
  assert.equal(summary.allTime.failed, 1);
  assert.equal(summary.allTime.unresolved, 1);
  assert.equal(summary.allTime.unknownCostRequests, 2);
});

test('replaying events does not duplicate charges; monthly grouping uses Japan time and includes ElevenLabs requests', async () => {
  const events: StudyEvent[] = [];
  await trackedAnthropicMessage(context, params, { append: async event => { events.push({ ...event, createdAt: '2026-09-30T15:30:00Z' }); }, create: async () => response });
  const audio: StudyEvent = { id: 'audio1', type: 'audio.requested', actorId: 'student', createdAt: '2026-10-02T00:00:00Z',
    payload: { cacheKey: 'a'.repeat(64), requestToken: 'c08c663d-d5df-4ad5-8976-a7bc0574f0f2', characters: 40 } };
  const summary = summarizeAiUsage([...events, ...events, audio, audio], members.map(profileForMember), new Date('2026-10-23T00:00:00Z'));
  assert.equal(summary.monthly.requests, 1);
  assert.equal(summary.monthly.estimatedUsd, 0.007725);
  assert.equal(summary.byFeature.find(item => item.feature === 'profile')?.usage.requests, 1);
  assert.equal(summary.byUser[0].name, 'Yusei');
  assert.equal(summary.elevenLabs.requests, 1);
  assert.equal(summary.elevenLabs.characters, 40);
  assert.equal(summary.elevenLabs.unresolved, 1);
  assert.equal(summary.elevenLabs.estimatedUsd, null);
});

test('cost events never enter the normal Manager/student state or its JSON export', async () => {
  const events: StudyEvent[] = [];
  await trackedAnthropicMessage(context, params, { append: async event => { events.push(event); }, create: async () => response });
  const profiles = members.map(profileForMember);
  const state = foldEvents(events, profiles);
  for (const profile of profiles) {
    const serialized = JSON.stringify(studyDataForProfile(state, profile));
    assert.equal(serialized.includes('estimatedUsd'), false);
    assert.equal(serialized.includes('msg_sample'), false);
    assert.equal(serialized.includes('logical-request'), false);
  }
});

test('Super User is only the verified allowlisted owner; Manager/student cannot escalate with accessLevel', async () => {
  const keys = ['ALLOWED_FAMILY_MEMBERS_JSON', 'NEXTAUTH_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.ALLOWED_FAMILY_MEMBERS_JSON = JSON.stringify(members);
    process.env.NEXTAUTH_SECRET = 'test-only-secret-with-at-least-thirty-two-characters';
    process.env.GOOGLE_CLIENT_ID = 'test-client'; process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    const profiles = getFamilyMembers().map(profileForMember);
    assert.equal(profiles[0].accessLevel, 'superuser');
    assert.equal(profiles[1].accessLevel, 'learner');
    assert.equal(profiles[2].accessLevel, 'learner');
    assert.equal(assertSuperUser(profiles[0]).id, 'super');
    for (const profile of profiles.slice(1)) {
      assert.throws(() => assertSuperUser({ ...profile, accessLevel: 'superuser', role: 'parent' }), (error: unknown) => error instanceof ApiError && error.status === 403);
    }
    assert.throws(() => assertSuperUser({ ...profiles[0], familyId: `${getFamilyId()}-other` }));
    const callbacks = getAuthOptions().callbacks!;
    const session = { expires: '2026-10-30T00:00:00Z', user: { email: members[0].email } };
    const unverified = await callbacks.session!({ session, token: { email: members[0].email, googleVerified: false }, user: { id: '' } } as any);
    assert.equal((unverified as any).profile, undefined);
    const verified = await callbacks.session!({ session, token: { email: members[0].email, googleVerified: true }, user: { id: '' } } as any);
    assert.equal((verified as any).profile.accessLevel, 'superuser');
    process.env.ALLOWED_FAMILY_MEMBERS_JSON = JSON.stringify(members.slice(1));
    assert.throws(() => assertSuperUser(profiles[0]));
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});


test('operational usage includes every account but never identifies or breaks down a participant', async () => {
  const events: StudyEvent[] = [];
  for (const actorId of ['PRIVATE_STUDENT', 'PRIVATE_OPERATOR']) {
    await trackedAnthropicMessage({ ...context, actorId }, params, {
      append: async event => { events.push({ ...event, createdAt: '2026-10-23T00:00:00Z' }); },
      create: async () => ({ ...response, id: `msg_${actorId}` }),
    });
  }
  events.push({ id: 'private-feedback', actorId: 'PRIVATE_STUDENT', type: 'feedback.submitted', createdAt: '2026-10-23T00:00:00Z',
    payload: { userId: 'PRIVATE_STUDENT', category: '困った', message: 'PRIVATE_CONTENT', version: '0.15.0' } });
  const summary = summarizeOperationalAiUsage(events, new Date('2026-10-23T12:00:00Z'));
  assert.equal(summary.monthly.requests, 2);
  assert.equal(summary.monthly.estimatedUsd, 0.01545);
  assert.deepEqual(summary.byUser, []);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_|actorId|userId|msg_|logical-request/);
});
