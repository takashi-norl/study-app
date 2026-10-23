import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import type { GenerationJob, LearningPlan, PlanningTurn, Profile, Topic } from '../../src/lib/types';
import { getFamilyId } from '../../src/server/env';
import { foldEvents, studyDataForProfile, type StudyEvent } from '../../src/server/google-store';
import { planTagsSchema, planTagsUpdateSchema, preparePlanTagsUpdate } from '../../src/server/plan-tags';
import { checkPlanningRequest } from '../../src/server/planning';
import { planningSampleSchema } from '../../src/server/planning-samples';

const time = '2026-10-22T00:00:00Z';
const later = new Date('2026-10-23T00:00:00Z');
const parent: Profile = { id: 'parent', name: '管理者', role: 'parent', familyId: getFamilyId() };
const student: Profile = { ...parent, id: 'student', name: '学習者', role: 'student' };
const other: Profile = { ...student, id: 'other' };
const profiles = [parent, student, other];
const plan = (id: string, ownerId = student.id, extra: Partial<LearningPlan> = {}): LearningPlan => ({
  id, ownerId, title: '英語の試験対策', subject: '英語', goal: '基礎を復習', difficulty: '標準', dailyQuestionTarget: 10,
  sourceIds: [], version: 3, createdAt: time, updatedAt: time, ...extra,
});
const event = (id: string, type: StudyEvent['type'], payload: unknown, actorId = student.id): StudyEvent => ({
  id, type, payload, actorId, createdAt: time,
});
const base = () => [
  event('create-own', 'plan.created', plan('own')),
  event('create-other', 'plan.created', plan('other-plan', other.id), other.id),
  event('create-parent', 'plan.created', plan('parent-plan', parent.id), parent.id),
  event('create-test', 'plan.created', plan('test-plan', parent.id, { testOnly: true }), parent.id),
];

// Frozen pre-tag reader contract: plan.updated is known, unknown fields are stripped,
// and only a strictly newer plan version can replace the previous plan.
const legacyIdSchema = z.string().min(1).max(200);
const legacyIsoSchema = z.string().refine(value => Number.isFinite(Date.parse(value)));
const legacyPlanSchema = z.object({
  id: legacyIdSchema, ownerId: legacyIdSchema, title: z.string().trim().min(1).max(150),
  subject: z.string().trim().min(1).max(40), goal: z.string().max(4000), difficulty: z.string().max(200),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dailyQuestionTarget: z.number().int().min(1).max(100), sourceIds: z.array(legacyIdSchema).max(20),
  requestedQuestionCount: z.number().int().min(1).max(300).optional(),
  testOnly: z.boolean().optional(), libraryTopicId: legacyIdSchema.optional(), sampleFirst: z.boolean().optional(),
  arrangedFromTopicId: legacyIdSchema.optional(), arrangementExamples: z.array(planningSampleSchema).max(3).optional(),
  arrangementInstructions: z.string().max(4000).optional(), plannedDays: z.number().int().min(1).max(300).optional(),
  version: z.number().int().min(1), createdAt: legacyIsoSchema, updatedAt: legacyIsoSchema,
});
function legacyPlanUpdate(previous: LearningPlan, update: StudyEvent): LearningPlan {
  z.enum(['plan.created', 'plan.updated']).parse(update.type);
  const parsed = legacyPlanSchema.parse(update.payload);
  return parsed.id === previous.id && parsed.ownerId === previous.ownerId && parsed.version > previous.version ? parsed : previous;
}

test('tags trim, deduplicate, clear, and reject invalid or over-limit values', () => {
  assert.deepEqual(planTagsSchema.parse([' 中間テスト ', '英語', '中間テスト']), ['中間テスト', '英語']);
  assert.deepEqual(planTagsSchema.parse([]), []);
  assert.equal(planTagsSchema.parse(['あ'.repeat(40)])[0].length, 40);
  assert.equal(planTagsSchema.parse(Array.from({ length: 8 }, (_, i) => `タグ${i}`)).length, 8);
  for (const tags of [[''], ['   '], ['あ'.repeat(41)], Array.from({ length: 9 }, (_, i) => `タグ${i}`), [1], '中間テスト']) {
    assert.equal(planTagsSchema.safeParse(tags).success, false);
  }
  assert.equal(planTagsUpdateSchema.safeParse({ tags: ['中間テスト'], ownerId: other.id, role: 'parent' }).success, false);
});

test('only a registered plan owner can change tags, including administrator-owned test plans', () => {
  const data = foldEvents(base(), profiles);
  assert.equal(preparePlanTagsUpdate(data, student, 'own', ['中間テスト'], later).plan.ownerId, student.id);
  assert.equal(preparePlanTagsUpdate(data, parent, 'parent-plan', ['運用確認'], later).plan.ownerId, parent.id);
  assert.deepEqual(preparePlanTagsUpdate(data, parent, 'test-plan', ['テスト'], later).plan.tags, ['テスト']);
  for (const [actor, id] of [
    [other, 'own'], [parent, 'own'], [student, 'test-plan'], [{ ...student, role: 'parent' }, 'own'],
    [{ ...student, familyId: 'foreign' }, 'own'], [{ ...student, id: 'unregistered' }, 'own'],
  ] as [Profile, string][]) {
    assert.throws(() => preparePlanTagsUpdate(data, actor, id, ['改変'], later), { code: 'PLAN_TAGS_FORBIDDEN' });
  }
  assert.throws(() => preparePlanTagsUpdate(data, student, 'missing', ['中間テスト'], later), { code: 'PLAN_NOT_FOUND' });
  data.plans.push(plan('invalid-test', student.id, { testOnly: true }));
  assert.throws(() => preparePlanTagsUpdate(data, student, 'invalid-test', ['中間テスト'], later), { code: 'PLAN_TAGS_FORBIDDEN' });
});

test('tag events persist without changing AI proposal versions or mutating the input', () => {
  const events = base();
  const data = foldEvents(events, profiles);
  const before = structuredClone(data);
  const prepared = preparePlanTagsUpdate(data, student, 'own', [' 中間テスト ', '英語', '中間テスト'], later, () => 'tags-one');
  assert.deepEqual(data, before);
  assert.equal(prepared.plan.version, 3);
  assert.equal(prepared.plan.updatedAt, later.toISOString());
  assert.equal(prepared.event?.type, 'plan.updated');
  assert.equal(prepared.event?.actorId, student.id);
  assert.equal(prepared.event?.payload.tagsOnly, true);
  assert.equal(prepared.event?.payload.version, 3);
  const stored = foldEvents([...events, prepared.event!, prepared.event!], profiles);
  const own = stored.plans.find(item => item.id === 'own')!;
  assert.equal(own.version, 3);
  assert.deepEqual(own.tags, ['中間テスト', '英語']);
  assert.equal(preparePlanTagsUpdate(stored, student, 'own', ['中間テスト', '英語']).event, undefined);
  assert.doesNotThrow(() => checkPlanningRequest(stored, student, own.id,
    { requestId: 'pending-request', expectedVersion: 3, message: 'もう少し難しくして' }, later));
  const turn: PlanningTurn = { id: 'next-turn', planId: own.id, requestedBy: student.id, version: 4,
    status: 'queued', message: 'もう少し難しくして', createdAt: later.toISOString() };
  const withTurn = foldEvents([...events, prepared.event!, event('turn', 'planning.turn.upserted', turn)], profiles);
  assert.equal(withTurn.planningTurns.length, 1);
  assert.equal(withTurn.plans.find(item => item.id === own.id)?.version, 4);
  assert.deepEqual(withTurn.plans.find(item => item.id === own.id)?.tags, ['中間テスト', '英語']);
  const cleared = preparePlanTagsUpdate(stored, student, own.id, [], later, () => 'clear-tags');
  assert.deepEqual(foldEvents([...events, prepared.event!, cleared.event!], profiles).plans.find(item => item.id === own.id)?.tags, []);
});

test('older readers recognize a full tag update and leave same-version or newer plan state unchanged', () => {
  const data = foldEvents(base(), profiles);
  const original = data.plans.find(item => item.id === 'own')!;
  const tagged = preparePlanTagsUpdate(data, student, original.id, ['中間テスト'], later, () => 'legacy-compatible');
  const parsed = legacyPlanSchema.parse(tagged.event!.payload);
  assert.equal(parsed.id, original.id);
  assert.equal(parsed.version, original.version);
  assert.equal('tags' in parsed, false);
  assert.equal('tagsOnly' in parsed, false);
  assert.deepEqual(legacyPlanUpdate(original, tagged.event!), original);
  const newer = { ...original, title: '旧版の作問で更新した内容', version: original.version + 1 };
  assert.deepEqual(legacyPlanUpdate(newer, tagged.event!), newer);
});

test('tag and in-flight content or generation updates preserve both changes in either event order', () => {
  const events = base();
  const data = foldEvents(events, profiles);
  const tagged = preparePlanTagsUpdate(data, student, 'own', ['中間テスト'], later, () => 'tag');
  const topic: Topic = { id: 'generated', title: '英語の試験対策', subject: '英語', description: '',
    createdAt: time, targetCount: 10, planId: 'own', audienceUserId: student.id };
  const job: GenerationJob = { id: 'job', topicId: topic.id, planId: 'own', requestedBy: student.id,
    audienceUserId: student.id, status: 'queued', targetCount: 10, generatedCount: 0, createdAt: time };
  const updatedPlan = { ...data.plans[0], version: 4, title: '更新したプラン', requestedQuestionCount: 10 };
  const generated = event('generate', 'generation.requested', { topic, job, updatedPlan });
  const updated = event('later-content', 'plan.updated', { ...updatedPlan, tags: ['古いタグ'] });
  for (const mutation of [generated, updated]) {
    for (const order of [[tagged.event!, mutation], [mutation, tagged.event!]]) {
      const stored = foldEvents([...events, ...order], profiles).plans.find(item => item.id === 'own')!;
      assert.equal(stored.version, 4);
      assert.equal(stored.title, '更新したプラン');
      assert.equal(stored.requestedQuestionCount, 10);
      assert.deepEqual(stored.tags, ['中間テスト']);
      assert.equal('tagsOnly' in stored, false);
    }
  }
});

test('tag-only updates cannot replace content, ownership, or version and require a valid explicit marker', () => {
  const events = base();
  const original = plan('own');
  const tagOnly = event('tag-only-content', 'plan.updated', {
    ...original, title: '適用しない内容', goal: '適用しない目標', tagsOnly: true, tags: ['中間テスト'],
  });
  const stored = foldEvents([...events, tagOnly], profiles).plans.find(item => item.id === original.id)!;
  assert.deepEqual(stored, { ...original, tags: ['中間テスト'] });
  const futureVersion = event('invalid-tag-version', 'plan.updated', { ...tagOnly.payload, version: original.version + 1 });
  assert.deepEqual(foldEvents([...events, futureVersion], profiles).plans.find(item => item.id === original.id), original);
  const unmarked = event('unmarked-tags', 'plan.updated', { ...original, tags: ['適用しない'] });
  assert.deepEqual(foldEvents([...events, unmarked], profiles).plans.find(item => item.id === original.id), original);
  for (const payload of [
    { ...original, tagsOnly: true },
    { ...original, tagsOnly: false, tags: ['中間テスト'] },
    { ...original, tagsOnly: true, tags: ['中間テスト'], role: 'parent' },
  ]) assert.throws(() => foldEvents([...events, event('invalid-marker', 'plan.updated', payload)], profiles));
});

test('forged tag events cannot alter another owner or unknown plan, and tags retain normal learner visibility', () => {
  const events = base();
  const tagged = preparePlanTagsUpdate(foldEvents(events, profiles), student, 'own', ['中間テスト'], later, () => 'tag');
  const forged = [
    event('admin-forged', 'plan.updated', { ...plan('own'), tagsOnly: true, tags: ['改変'] }, parent.id),
    event('owner-forged', 'plan.updated', { ...plan('own', other.id), tagsOnly: true, tags: ['改変'] }, other.id),
    event('unknown-forged', 'plan.updated', { ...plan('missing'), tagsOnly: true, tags: ['改変'] }),
  ];
  const stored = foldEvents([...events, tagged.event!, ...forged], profiles);
  assert.deepEqual(stored.plans.find(item => item.id === 'own')?.tags, ['中間テスト']);
  assert.equal(stored.plans.some(item => item.id === 'missing'), false);
  assert.deepEqual(studyDataForProfile(stored, student).plans.map(item => [item.id, item.tags]), [['own', ['中間テスト']]]);
  assert.equal(JSON.stringify(studyDataForProfile(stored, other)).includes('中間テスト'), false);
  assert.deepEqual(studyDataForProfile(stored, parent).plans.find(item => item.id === 'own')?.tags, ['中間テスト']);
});

test('tag replay requires the owner to be a current member of the configured family', () => {
  const missingOwner = { ...student, id: 'removed-owner' };
  const foreignOwner = { ...student, id: 'foreign-owner', familyId: 'another-family' };
  const events = [missingOwner, foreignOwner].flatMap(owner => [
    event(`plan-${owner.id}`, 'plan.created', plan(`owned-by-${owner.id}`, owner.id), owner.id),
    event(`tags-${owner.id}`, 'plan.updated', {
      ...plan(`owned-by-${owner.id}`, owner.id), tagsOnly: true, tags: ['適用しない'],
    }, owner.id),
  ]);
  const stored = foldEvents(events, [...profiles, foreignOwner]);
  assert.ok(stored.plans.every(item => item.tags === undefined));
});
