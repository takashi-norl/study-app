import assert from 'node:assert/strict';
import test from 'node:test';
import { foldEvents, studyDataForProfile, type StudyEvent } from '../../src/server/google-store';
import { canAccessPlan, canAccessQuestion, canAccessSource } from '../../src/server/access';
import { getFamilyId } from '../../src/server/env';
import type { GenerationJob, LearningPlan, PlanningTurn, Profile, Question, Topic } from '../../src/lib/types';

const time='2026-10-22T00:00:00Z';
const parent:Profile={id:'parent',name:'Parent',role:'parent',familyId:getFamilyId()};
const student:Profile={id:'student-one',name:'Student',role:'student',familyId:getFamilyId()};
const other:Profile={id:'student-two',name:'Other',role:'student',familyId:getFamilyId()};
const event=(id:string,type:StudyEvent['type'],payload:unknown):StudyEvent=>({id,type,actorId:parent.id,createdAt:time,payload});
const plan=(id:string,ownerId:string):LearningPlan=>({id,ownerId,title:'世界史の学習',subject:'世界史',goal:'出来事のつながりを理解する',difficulty:'高校基礎',dailyQuestionTarget:10,sourceIds:[],version:1,createdAt:time,updatedAt:time});
const turn=(id:string,planId:string,ownerId:string):PlanningTurn=>({id,planId,requestedBy:ownerId,version:2,status:'queued',message:'資料なしで基礎問題を相談したい',createdAt:time});
const topic=(id:string,audienceUserId?:string):Topic=>({id,title:'科学の基礎',subject:'理科',description:'',createdAt:time,targetCount:10,audienceUserId});
const question=(id:string,topicId:string,audienceUserId?:string):Question=>({id,topicId,prompt:'資料なしの確認問題',choices:['A','B','C','D'],correctIndex:1,explanation:'PRIVATE_ANSWER',learningPoint:'確認',sourceIds:[],sourceNote:'一般知識に基づくAI生成',status:'published',version:1,createdAt:time,publishedAt:time,needsReview:true,audienceUserId});

test('requested question totals survive saved events and student projection alongside legacy plans',()=>{
  const legacy=plan('legacy-plan',student.id);
  const selected={...plan('selected-plan',student.id),requestedQuestionCount:100};
  const data=foldEvents([event('legacy','plan.created',legacy),event('selected','plan.created',selected)],[parent,student]);
  const visible=studyDataForProfile(data,student,new Date(time));
  assert.equal(visible.plans[0].requestedQuestionCount,undefined);
  assert.equal(visible.plans[1].requestedQuestionCount,100);
  assert.equal(visible.plans[1].dailyQuestionTarget,10);
});

test('legacy sources stay parent-only; students see only their own bank and plans',()=>{
  const events:StudyEvent[]=[];
  for(const [id,ownerId] of [['legacy',undefined],['parent-source',parent.id],['own-source',student.id],['other-source',other.id]] as const) {
    events.push(event(id,'source.created',{id,ownerId,name:'source.jpg',mimeType:'image/jpeg',createdAt:time}));
  }
  for(const owner of [parent,student,other]) {
    const p=plan(`plan-${owner.id}`,owner.id);
    events.push(event(p.id,'plan.created',p),event(`turn-${owner.id}`,'planning.turn.upserted',turn(`turn-${owner.id}`,p.id,owner.id)));
  }
  const data=foldEvents(events,[parent,student,other]);
  const visible=studyDataForProfile(data,student,new Date(time));
  assert.deepEqual(visible.sources.map(s=>s.id),['own-source']);
  assert.equal(visible.sources[0].previewUrl,'/api/sources/own-source');
  assert.equal(visible.sources[0].topicId,undefined);
  assert.deepEqual(visible.plans.map(p=>p.id),[`plan-${student.id}`]);
  assert.deepEqual(visible.planningTurns.map(t=>t.id),[`turn-${student.id}`]);
  const all=studyDataForProfile(data,parent,new Date(time));
  assert.equal(all.sources.length,4);
  assert.equal(all.plans.length,3);
  assert.equal(all.planningTurns.length,3);
  assert.equal(canAccessSource({},student),false);
  assert.equal(canAccessSource({ownerId:other.id},student),false);
  assert.equal(canAccessSource({ownerId:other.id},parent),true);
  assert.equal(canAccessPlan(plan('p',other.id),student),false);
});

test('private published AI questions are usable only by their student while parents can inspect them',()=>{
  const events:StudyEvent[]=[];
  for(const [id,audience] of [['family',undefined],['own',student.id],['other',other.id]] as const) {
    events.push(event(`topic-${id}`,'topic.created',topic(id,audience)),event(`q-${id}`,'question.upserted',question(`q-${id}`,id,audience)));
  }
  const data=foldEvents(events,[parent,student,other]);
  const visible=studyDataForProfile(data,student,new Date(time));
  assert.deepEqual(visible.questions.map(q=>q.id),['q-family','q-own']);
  assert.deepEqual(visible.topics.map(t=>t.id),['family','own']);
  assert.equal(visible.questions.find(q=>q.id==='q-own')?.needsReview,true);
  assert.equal(JSON.stringify(visible).includes('PRIVATE_ANSWER'),false);
  assert.equal(studyDataForProfile(data,parent,new Date(time)).questions.length,3);
  assert.equal(canAccessQuestion({audienceUserId:other.id},student),false);
});

test('one conversation turn wins each plan version and completed turns cannot regress',()=>{
  const p=plan('p',student.id);
  const first=turn('first',p.id,student.id);
  const complete={...first,status:'complete' as const,reply:'基礎から確認しましょう',proposals:[{id:'proposal',title:'世界史の基礎',subject:'世界史',description:'流れの確認',instructions:'年代の丸暗記に偏らない',difficulty:'基礎',targetCount:10,format:'multiple-choice' as const,sourceIds:[]}]};
  const events=[
    event('p','plan.created',p),
    event('claim-first','planning.turn.upserted',first),
    event('claim-loser','planning.turn.upserted',{...first,id:'loser'}),
    event('wrong-owner','planning.turn.upserted',{...first,id:'wrong',version:3,requestedBy:other.id}),
    event('running','planning.turn.upserted',{...first,status:'running'}),
    event('complete','planning.turn.upserted',complete),
    event('late-running','planning.turn.upserted',{...first,status:'running'}),
    event('late-failed','planning.turn.upserted',{...first,status:'failed'}),
    event('next','planning.turn.upserted',{...first,id:'next',version:3,message:'少し難しくして'}),
  ];
  const data=foldEvents(events);
  assert.deepEqual(data.planningTurns.map(t=>t.id),['first','next']);
  assert.equal(data.planningTurns[0].status,'complete');
  assert.equal(data.planningTurns[0].proposals?.[0].format,'multiple-choice');
  assert.equal(data.plans[0].version,3);
});

test('generation reservation creates its topic and job together and keeps private-plan provenance',()=>{
  const t={...topic('new-topic',student.id),planId:'plan-one'};
  const job:GenerationJob={id:'job-one',topicId:t.id,status:'queued',targetCount:10,generatedCount:0,createdAt:time,
    audienceUserId:student.id,planId:t.planId,sourceIds:[],instructions:'英検準1級の語彙を4択で確認',requestedBy:student.id,
    proposalId:'proposal-one',turnId:'turn-one',requestId:'request-one'};
  const data=foldEvents([
    event('paid-slot','generation.requested',{topic:t,job}),
    event('paid-slot','generation.requested',{topic:{...t,id:'losing-topic'},job:{...job,id:'losing-job',topicId:'losing-topic'}}),
  ]);
  assert.deepEqual(data.topics.map(t=>t.id),['new-topic']);
  assert.deepEqual(data.jobs,[job]);
  assert.equal(studyDataForProfile(data,student,new Date(time)).jobs.length,1);
  assert.equal(studyDataForProfile(data,other,new Date(time)).jobs.length,0);
  assert.throws(()=>foldEvents([event('mismatch','generation.requested',{topic:t,job:{...job,audienceUserId:other.id}})]));
});
