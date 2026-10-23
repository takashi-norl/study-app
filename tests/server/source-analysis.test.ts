import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearningPlan, PlanningTurn, Profile, SourceDocument } from '../../src/lib/types';
import { foldEvents, type StudyEvent } from '../../src/server/google-store';
import { getFamilyId } from '../../src/server/env';
import { assertSourceAnalysesCurrent, latestSourceAnalysis, prepareSourceAnalysisUpdate, requireSourceAnalysisAccess, sourceAnalysisView } from '../../src/server/source-analysis';
import { sourceAnalysisUpdateSchema } from '../../src/server/source-analysis-schema';
import { buildPlanningContext } from '../../src/server/planning';
import { planningProgress } from '../../src/server/planning-progress';

const time = '2026-10-23T00:00:00.000Z';
const later = new Date('2026-10-23T00:01:00.000Z');
const parent: Profile = { id: 'parent', name: '管理者', role: 'parent', familyId: getFamilyId() };
const student: Profile = { ...parent, id: 'student', name: '学習者', role: 'student' };
const other: Profile = { ...student, id: 'other' };
const profiles = [parent, student, other];
const sourceId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const source: SourceDocument = { id: sourceId, ownerId: student.id, name: '古文の範囲.jpg', mimeType: 'image/jpeg', storagePath: 'private-file', createdAt: time };
const plan: LearningPlan = { id: 'plan', ownerId: student.id, title: '中間テストの古文', subject: '古文', goal: '原本の範囲を復習', difficulty: '基礎', sourceIds: [sourceId], dailyQuestionTarget: 10, version: 2, createdAt: time, updatedAt: time };
const analysis = { text: 'No.26 あはれなり（p.50）', learningPoints: ['古文単語'], uncertainties: ['例文末尾は判読不可'] };
const event = (id: string, type: StudyEvent['type'], payload: unknown, actorId = student.id, createdAt = time): StudyEvent => ({ id, type, payload, actorId, createdAt });
const baseline = () => event(`source-analysis:${sourceId}`, 'source.analysis', { sourceId, text: JSON.stringify({ text: '誤読した古い本文', learningPoints: ['誤った分類'], uncertainties: [] }) });
const base = () => [event('source', 'source.created', source), event('plan', 'plan.created', plan), baseline()];
const input = (expectedRevision: string | null = baseline().id) => ({ requestId, expectedRevision, ...analysis });

test('manual reading is append-only, old event readers remain compatible, and the current reading wins everywhere', () => {
  const events = base();
  const original = structuredClone(events);
  const corrected = prepareSourceAnalysisUpdate(foldEvents(events, profiles), events, student, sourceId, input(), later);
  assert.deepEqual(events, original);
  assert.equal(corrected.event?.type, 'source.analysis');
  assert.equal(corrected.event?.id, `source-analysis:${sourceId}:revision:1`);
  assert.equal(corrected.view.reviewed, true);
  assert.deepEqual(corrected.view.analysis, analysis);
  assert.equal(corrected.view.revision, corrected.event?.id);
  const all = [...events, corrected.event!];
  assert.doesNotThrow(() => foldEvents(all, profiles));
  assert.equal(latestSourceAnalysis(all, sourceId)?.id, corrected.event?.id);
  assert.equal(all.find(item => item.id === baseline().id)?.payload.text, baseline().payload.text, 'preserve the original extraction for history');
  const turn: PlanningTurn = { id: 'turn-new', planId: plan.id, requestedBy: student.id, version: 3, status: 'queued', message: '原本の語句で作って', createdAt: '2026-10-23T00:02:00.000Z' };
  const context = buildPlanningContext(foldEvents(all, profiles), all, plan, turn, student, later);
  assert.match(context.untrustedSourceExcerpts[0].analysisExcerpt, /あはれなり/);
  assert.doesNotMatch(JSON.stringify(context.untrustedSourceExcerpts), /誤読した/);
  assert.equal(planningProgress(turn, [sourceId], all, 'queued').progress?.sourcesCompleted, 1);
  assert.equal(planningProgress(turn, [sourceId], all, 'queued').progress?.sourcesRequiringAnalysis, 0);
});

test('only registered owners can read or correct, without exposing sibling, unowned, or test sources', () => {
  const events = base();
  const data = foldEvents(events, profiles);
  assert.equal(requireSourceAnalysisAccess(data, student, sourceId).id, sourceId);
  assert.throws(() => prepareSourceAnalysisUpdate(data, events, parent, sourceId, input(), later), { code: 'SOURCE_NOT_FOUND' });
  assert.throws(() => requireSourceAnalysisAccess(data, other, sourceId), { code: 'SOURCE_NOT_FOUND' });
  for (const actor of [{ ...student, role: 'parent' as const }, { ...student, familyId: 'foreign' }, { ...student, id: 'not-registered' }]) {
    assert.throws(() => requireSourceAnalysisAccess(data, actor, sourceId), { code: 'SOURCE_ANALYSIS_FORBIDDEN' });
    assert.throws(() => prepareSourceAnalysisUpdate(data, events, actor, sourceId, input()), { code: 'SOURCE_ANALYSIS_FORBIDDEN' });
  }
  data.sources[0].ownerId = undefined;
  assert.throws(() => requireSourceAnalysisAccess(data, student, sourceId), { code: 'SOURCE_NOT_FOUND' });
  assert.throws(() => requireSourceAnalysisAccess(data, parent, sourceId), { code: 'SOURCE_NOT_FOUND' });
  data.sources[0].ownerId = student.id; data.sources[0].testOnly = true;
  assert.throws(() => requireSourceAnalysisAccess(data, student, sourceId), { code: 'SOURCE_NOT_FOUND' });
  assert.throws(() => requireSourceAnalysisAccess(data, parent, 'missing'), { code: 'SOURCE_NOT_FOUND' });
});

test('save retries never overwrite a newer edit and simultaneous changes use one canonical revision slot', () => {
  const events = base();
  const data = foldEvents(events, profiles);
  const first = prepareSourceAnalysisUpdate(data, events, student, sourceId, input(), later).event!;
  const competing = prepareSourceAnalysisUpdate(data, events, student, sourceId, { ...input(), requestId: '33333333-3333-4333-8333-333333333333', text: '競合した別の本文' }, later).event!;
  assert.equal(competing.id, first.id);
  const saved = [...events, first, competing];
  assert.equal(latestSourceAnalysis(saved, sourceId)?.payload.text, first.payload.text);
  assert.equal(prepareSourceAnalysisUpdate(data, saved, student, sourceId, input(), later).event, undefined);
  assert.throws(() => prepareSourceAnalysisUpdate(data, saved, student, sourceId, { ...input(), requestId: '44444444-4444-4444-8444-444444444444' }), { code: 'SOURCE_ANALYSIS_CONFLICT' });
  assert.throws(() => prepareSourceAnalysisUpdate(data, saved, student, sourceId, { ...input(), text: '同じ保存番号で違う内容' }), { code: 'SOURCE_ANALYSIS_REQUEST_CONFLICT' });
  const second = prepareSourceAnalysisUpdate(data, saved, student, sourceId, { ...input(first.id), requestId: '55555555-5555-4555-8555-555555555555', text: '再確認した本文' }, new Date('2026-10-23T00:03:00Z')).event!;
  assert.equal(latestSourceAnalysis([...saved, second], sourceId)?.id, second.id);
  assert.throws(() => prepareSourceAnalysisUpdate(data, [...saved, second], student, sourceId, input()), { code: 'SOURCE_ANALYSIS_CONFLICT' });
});

test('only well-formed contiguous revision chains are accepted, including manual reading before any OCR', () => {
  const events = base().filter(item => item.type !== 'source.analysis');
  const correction = prepareSourceAnalysisUpdate(foldEvents(events, profiles), events, student, sourceId, input(null), later).event!;
  const saved = [...events, correction, baseline()];
  assert.equal(latestSourceAnalysis(saved, sourceId)?.id, correction.id, 'late initial extraction must not replace a manual correction');
  for (const wrong of [
    { ...correction, id: 'wrong-id' },
    { ...correction, id: `source-analysis:${sourceId}:revision:2`, payload: { ...correction.payload, revision: 2 } },
    { ...correction, payload: { ...correction.payload, previousRevision: 'other-source' } },
    { ...correction, payload: { ...correction.payload, text: '{"text":"missing required arrays"}' } },
  ]) assert.equal(latestSourceAnalysis([...events, wrong], sourceId), undefined);
  assert.throws(() => foldEvents([...events, { ...correction, payload: { ...correction.payload, reviewed: false } }], profiles));
  assert.deepEqual(sourceAnalysisView(events, sourceId), { sourceId, revision: null, analysis: null, reviewed: false });
  assert.equal(planningProgress({ id: 'turn', planId: plan.id, requestedBy: student.id, version: 3, status: 'queued', message: '確認', createdAt: time }, [sourceId], saved, 'queued').progress?.sourcesCompleted, 1);
});

test('a source in active planning or generation cannot be changed; unrelated work does not block correction', () => {
  const events = base();
  for (const status of ['queued', 'running'] as const) {
    const data = foldEvents(events, profiles);
    data.planningTurns.push({ id: 'turn', planId: plan.id, requestedBy: student.id, version: 3, status, message: '相談', createdAt: time });
    assert.throws(() => prepareSourceAnalysisUpdate(data, events, student, sourceId, input()), { code: 'SOURCE_ANALYSIS_ACTIVE' });
    data.planningTurns = [];
    data.jobs.push({ id: 'job', topicId: 'topic', requestedBy: student.id, sourceIds: [sourceId], status, targetCount: 10, generatedCount: 0, createdAt: time });
    assert.throws(() => prepareSourceAnalysisUpdate(data, events, student, sourceId, input()), { code: 'SOURCE_ANALYSIS_ACTIVE' });
    data.jobs[0].sourceIds = ['unrelated'];
    assert.doesNotThrow(() => prepareSourceAnalysisUpdate(data, events, student, sourceId, input()));
    data.jobs[0].sourceIds = undefined; data.jobs[0].planId = plan.id;
    assert.throws(() => prepareSourceAnalysisUpdate(data, events, student, sourceId, input()), { code: 'SOURCE_ANALYSIS_ACTIVE' });
  }
});

test('source corrections invalidate old approvals and old AI claims, preserving the learner request', () => {
  const events = base();
  const old: PlanningTurn = { id: 'old-turn', planId: plan.id, requestedBy: student.id, version: 3, status: 'complete', message: '現代語訳は解説にだけ載せて', reply: 'OBSOLETE_AI_CLAIM', proposals: [], createdAt: time };
  events.push(event('old-turn-queued', 'planning.turn.upserted', { ...old, status: 'queued' }), event('old-turn', 'planning.turn.upserted', old));
  const corrected = prepareSourceAnalysisUpdate(foldEvents(events, profiles), events, student, sourceId, input(), later).event!;
  events.push(corrected);
  assert.throws(() => assertSourceAnalysesCurrent(events, [sourceId], old.createdAt), { code: 'SOURCE_ANALYSIS_CHANGED' });
  assert.throws(() => assertSourceAnalysesCurrent(events, [sourceId], later.toISOString()), { code: 'SOURCE_ANALYSIS_CHANGED' });
  assert.doesNotThrow(() => assertSourceAnalysesCurrent(events, [sourceId], '2026-10-23T00:02:00Z'));
  assert.doesNotThrow(() => assertSourceAnalysesCurrent(events, ['unrelated'], time));
  const next: PlanningTurn = { ...old, id: 'next-turn', version: 4, status: 'queued', createdAt: '2026-10-23T00:02:00Z' };
  const context = buildPlanningContext(foldEvents(events, profiles), events, plan, next, student);
  assert.doesNotMatch(JSON.stringify(context), /OBSOLETE_AI_CLAIM/);
  assert.match(JSON.stringify(context.untrustedConversationHistory), /現代語訳は解説にだけ/);
  assert.equal(context.untrustedConversationHistory[0].sourceReadingChanged, true);
});

test('manual reading input retains uncertainty and rejects empty, overlong, or forged metadata', () => {
  assert.deepEqual(sourceAnalysisUpdateSchema.parse({ ...input(), text: ' 原本にある本文 ' }).text, '原本にある本文');
  for (const invalid of [
    { ...input(), text: ' ' }, { ...input(), text: 'あ'.repeat(18001) },
    { ...input(), uncertainties: ['あ'.repeat(301)] }, { ...input(), reviewed: true },
    { ...input(), ownerId: other.id }, { ...input(), expectedRevision: undefined },
  ]) assert.equal(sourceAnalysisUpdateSchema.safeParse(invalid).success, false);
});
