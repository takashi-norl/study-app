import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJob, LearningPlan, PlanningProposal, PlanningTurn, Profile, StudyData } from '../../src/lib/types';
import { assertGenerationAccess, currentProposal, generationInstructions, generationReplay } from '../../src/server/proposal-selection';
import { materializeQuestions } from '../../src/server/generated-batch';

const student: Profile = { id: 'student', familyId: 'family-primary', name: 'Learner', role: 'student' };
const parent: Profile = { ...student, id: 'parent', role: 'parent' };
const now = '2026-10-22T15:00:00.000Z';
const plan: LearningPlan = { id: 'plan', ownerId: student.id, title: '語彙', subject: '英語', goal: '10か月で語彙を増やす', difficulty: '基礎', dailyQuestionTarget: 10, sourceIds: [], version: 2, createdAt: now, updatedAt: now };
const proposal: PlanningProposal = { id: 'turn:0', title: '語彙の確認', subject: '英語', description: '短い例文で確認', instructions: 'まず基礎語彙', difficulty: '基礎', targetCount: 10, format: 'multiple-choice', sourceIds: [] };
const turn: PlanningTurn = { id: 'turn', planId: plan.id, requestedBy: student.id, version: 2, status: 'complete', message: '基礎から', proposals: [proposal], createdAt: now };
const state: StudyData = { topics: [], sources: [], questions: [], attempts: [], exposures: [], sessions: [], jobs: [], profiles: [student, parent], plans: [plan], planningTurns: [turn] };
const selection = { expectedVersion: 2, turnId: turn.id, proposalId: proposal.id };

test('only the owner can generate from the current completed proposal, even when parent can view it', () => {
  assert.equal(currentProposal(state, student, plan.id, selection).proposal.id, proposal.id);
  assert.throws(() => currentProposal(state, parent, plan.id, selection), { code: 'PLAN_NOT_FOUND' });
  assert.throws(() => currentProposal(state, student, plan.id, { ...selection, expectedVersion: 1 }), { code: 'VERSION_CONFLICT' });
  for (const changed of [{ ...turn, status: 'running' as const }, { ...turn, version: 1 }, { ...turn, requestedBy: parent.id }]) {
    assert.throws(() => currentProposal({ ...state, planningTurns: [changed] }, student, plan.id, selection), { code: 'STALE_PROPOSAL' });
  }
  assert.throws(() => currentProposal({ ...state, planningTurns: [{ ...turn, proposals: [{ ...proposal, sourceIds: ['unselected'] }] }] }, student, plan.id, selection), { code: 'INVALID_AI_SOURCE' });
});

const job: GenerationJob = { id: 'job', topicId: 'topic', status: 'running', targetCount: 10, generatedCount: 0, createdAt: now, requestedBy: student.id, audienceUserId: student.id, planId: plan.id };
const candidate = { prompt: 'Select the meaning of apple.', choices: ['りんご', '犬', '青', '走る'], correctIndex: 0, explanation: 'apple はりんごという意味です。', learningPoint: '基本語彙', sourceIds: [] as string[], sourceNote: 'AI作成・資料なし' };

test('learner-owned practice is immediately available and private without entering the parent review queue', () => {
  const own = materializeQuestions([candidate], { job, sourceIds: [], prior: [], count: 10, createdAt: now })[0];
  assert.equal(own.status, 'published'); assert.equal(own.audienceUserId, student.id); assert.equal(own.publishedAt, now); assert.equal(own.needsReview, false);
  for (const parentJob of [{ ...job, requestedBy: parent.id, audienceUserId: undefined }, { ...job, requestedBy: parent.id }]) {
    const draft = materializeQuestions([candidate], { job: parentJob, sourceIds: [], prior: [], count: 10, createdAt: now })[0];
    assert.equal(draft.status, 'published'); assert.equal(draft.publishedAt, now); assert.equal(draft.ownerId,parent.id); assert.equal(draft.aiGenerated,true);
  }
});

test('generation retries resolve the original set and reject reuse with changed title, count or proposal', () => {
  const savedJob={...job,requestId:'request',turnId:turn.id,proposalId:proposal.id,status:'queued' as const};
  const topic={id:job.topicId,title:proposal.title,subject:'英語',description:'',targetCount:10,createdAt:now,planId:plan.id,audienceUserId:student.id};
  const data={...state,jobs:[savedJob],topics:[topic]};
  const request={requestId:'request',planId:plan.id,turnId:turn.id,proposalId:proposal.id};
  assert.equal(generationReplay(data,student,request)?.job.id,job.id);
  assert.equal(generationReplay({...data,plans:[{...plan,version:5}]},student,request)?.topic.id,topic.id);
  assert.equal(generationReplay(data,parent,request),undefined);
  for(const changed of [{targetCount:20},{title:'Changed'},{proposalId:'other'}]) assert.throws(()=>generationReplay(data,student,{...request,...changed}),{code:'REQUEST_CONFLICT'});
  assert.throws(()=>generationReplay({...data,topics:[]},student,request),{code:'TOPIC_NOT_FOUND'});
});

test('generation instructions fit the persisted event budget and prioritize the latest arrangement', () => {
  const text=generationInstructions({...plan,goal:'目'.repeat(4000),difficulty:'旧'.repeat(200)},{...proposal,instructions:'最新の相談: '+ '問'.repeat(4000),difficulty:'新'.repeat(200)});
  assert.ok(text.length<=4000);
  assert.match(text,/^今回の作問指示: 最新の相談/);
  assert.match(text,/今回の難易度/);
  assert.match(text,/長期目標/);
});

test('generation rechecks removed membership, downgraded roles and source ownership even for cached sources', () => {
  const topic={id:job.topicId,title:proposal.title,subject:'英語',description:'',targetCount:10,createdAt:now,planId:plan.id,audienceUserId:student.id};
  const data={...state,topics:[topic],sources:[{id:'source',ownerId:student.id,name:'source',mimeType:'image/jpeg',storagePath:'drive-file',createdAt:now}]};
  const withSource={...job,sourceIds:['source']};
  assert.equal(assertGenerationAccess(data,withSource).id,student.id);
  assert.throws(()=>assertGenerationAccess({...data,profiles:[parent]},withSource),{code:'GENERATION_ACCESS_DENIED'});
  assert.throws(()=>assertGenerationAccess({...data,sources:[{...data.sources[0],ownerId:parent.id}]},withSource),{code:'GENERATION_ACCESS_DENIED'});
  assert.throws(()=>assertGenerationAccess(data,{...withSource,requestedBy:parent.id}),{code:'GENERATION_ACCESS_DENIED'});
  assert.throws(()=>assertGenerationAccess(data,{...withSource,audienceUserId:undefined}),{code:'GENERATION_ACCESS_DENIED'});
});

test('source-backed batches reject missing/foreign citations; knowledge batches cannot fabricate citations; duplicates and counts remain bounded', () => {
  const sourced = { ...candidate, sourceIds: ['selected'] };
  const wrong = { ...candidate, sourceIds: ['other'] };
  const rows = materializeQuestions([candidate, wrong, sourced, { ...sourced, prompt: 'Ｓｅｌｅｃｔ the meaning of apple.' }], { job, sourceIds: ['selected'], prior: [], count: 10, createdAt: now });
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].sourceIds, ['selected']);
  assert.equal(materializeQuestions([wrong, candidate], { job, sourceIds: [], prior: [], count: 1, createdAt: now }).length, 1);
  assert.equal(materializeQuestions([candidate], { job, sourceIds: [], prior: rows, count: 10, createdAt: now }).length, 0);
});
