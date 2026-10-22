import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearningPlan, PlanningTurn, Profile, StudyData } from '../../src/lib/types';
import type { StudyEvent } from '../../src/server/google-store';
import { buildPlanningContext, checkPlanningRequest, createPlanSchema, learningSummary, paidWorkSlotId, requireOwnedPlan, validatePlanningReply, validatePlanningSources } from '../../src/server/planning';

const student:Profile={id:'student',familyId:'family',name:'Student',role:'student'};
const parent:Profile={id:'parent',familyId:'family',name:'Parent',role:'parent'};
const other:Profile={id:'other',familyId:'family',name:'OTHER_PRIVATE_NAME',role:'student'};
const now=new Date('2026-10-22T15:30:00Z');
const sourceId='bd44916c-9994-4cee-8cf7-0a063ae17d87';
const plan:LearningPlan={id:'plan',ownerId:student.id,title:'英語の語彙',subject:'英語',goal:'10か月で語彙を増やす',difficulty:'相談',dailyQuestionTarget:10,sourceIds:[],version:1,createdAt:now.toISOString(),updatedAt:now.toISOString()};
const turn:PlanningTurn={id:'4167726c-4e4e-4adc-b86f-c5c00bb1364f',planId:plan.id,requestedBy:student.id,version:2,status:'queued',message:'10問ずつ練習したい',createdAt:now.toISOString()};
function state():StudyData {return {plans:[structuredClone(plan)],planningTurns:[],topics:[],sources:[],questions:[],attempts:[],exposures:[],sessions:[],jobs:[],profiles:[student,parent,other]};}
const input={requestId:turn.id,expectedVersion:1,message:turn.message};

test('a plan accepts optional sources and arbitrary school subjects, but rejects invalid calendar dates and excess material',()=>{
  assert.deepEqual(createPlanSchema.parse({subject:'日本史',goal:'期末テスト対策'}).sourceIds,[]);
  assert.equal(createPlanSchema.parse({subject:'化学',goal:'反応式',targetDate:'2028-02-29'}).targetDate,'2028-02-29');
  for(const targetDate of ['2026-02-29','2026-99-99','2026-04-31']) assert.equal(createPlanSchema.safeParse({subject:'英語',goal:'目標',targetDate}).success,false);
  assert.equal(createPlanSchema.safeParse({subject:'英語',goal:'目標',sourceIds:Array(21).fill(sourceId)}).success,false);
});

test('parents can inspect a child plan but cannot write; other students cannot discover it',()=>{
  assert.equal(requireOwnedPlan(state(),student,plan.id).id,plan.id);
  assert.throws(()=>requireOwnedPlan(state(),parent,plan.id),{code:'PLAN_READ_ONLY'});
  assert.throws(()=>requireOwnedPlan(state(),other,plan.id),{code:'PLAN_NOT_FOUND'});
});

test('new turns reject stale versions and either type of active family AI work',()=>{
  const data=state();
  assert.equal(checkPlanningRequest(data,student,plan.id,input,now).previous,undefined);
  assert.throws(()=>checkPlanningRequest(data,student,plan.id,{...input,expectedVersion:2},now),{code:'STALE_PLAN'});
  data.planningTurns=[{...turn,id:'other-turn',planId:'other-plan'}];
  assert.throws(()=>checkPlanningRequest(data,student,plan.id,input,now),{code:'AI_WORK_ACTIVE'});
  data.planningTurns=[];
  data.jobs=[{id:'job',topicId:'topic',status:'running',targetCount:10,generatedCount:0,createdAt:now.toISOString()}];
  assert.throws(()=>checkPlanningRequest(data,student,plan.id,input,now),{code:'AI_WORK_ACTIVE'});
});

test('request retries return the canonical turn even after version changes; UUID reuse for changed text is rejected',()=>{
  const data=state();data.plans[0].version=4;data.planningTurns=[{...turn,status:'complete',reply:'完成'}];
  assert.equal(checkPlanningRequest(data,student,plan.id,input,now).previous?.reply,'完成');
  assert.throws(()=>checkPlanningRequest(data,student,plan.id,{...input,message:'different'},now),{code:'REQUEST_CONFLICT'});
});

test('consultation limits use Japan calendar dates and count failed paid work',()=>{
  const data=state();
  data.planningTurns=Array.from({length:20},(_,index)=>({...turn,id:`turn-${index}`,status:'failed',createdAt:'2026-10-22T15:01:00Z'}));
  assert.throws(()=>checkPlanningRequest(data,student,plan.id,input,now),{code:'PLANNING_DAILY_LIMIT'});
  data.planningTurns=Array.from({length:100},(_,index)=>({...turn,id:`turn-${index}`,status:'complete',createdAt:'2026-10-01T00:00:00Z'}));
  assert.throws(()=>checkPlanningRequest(data,student,plan.id,input,now),{code:'PLANNING_MONTHLY_LIMIT'});
  data.planningTurns=Array.from({length:20},(_,index)=>({...turn,id:`turn-${index}`,status:'failed',createdAt:'2026-10-22T14:59:00Z'}));
  assert.doesNotThrow(()=>checkPlanningRequest(data,student,plan.id,input,now));
});

test('paid event slot is shared across work types and stable under reordering',()=>{
  const data=state();const empty=paidWorkSlotId(data);
  data.planningTurns=[turn];const withTurn=paidWorkSlotId(data);assert.notEqual(empty,withTurn);
  data.jobs=[{id:'job',topicId:'topic',status:'failed',targetCount:10,generatedCount:0,createdAt:now.toISOString()}];
  const both=paidWorkSlotId(data);assert.notEqual(withTurn,both);
  assert.equal(both,paidWorkSlotId({...data,jobs:[...data.jobs].reverse(),planningTurns:[...data.planningTurns].reverse()}));
});

test('a student cannot attach another owner or legacy private source',()=>{
  const data=state();
  data.sources=[{id:sourceId,name:'Source',mimeType:'image/jpeg',ownerId:parent.id,storagePath:'drive-file',createdAt:now.toISOString()}];
  assert.throws(()=>validatePlanningSources(data,student,[sourceId]),{code:'SOURCE_NOT_FOUND'});
  delete data.sources[0].ownerId;
  assert.throws(()=>validatePlanningSources(data,student,[sourceId]),{code:'SOURCE_NOT_FOUND'});
  assert.doesNotThrow(()=>validatePlanningSources(data,parent,[sourceId]));
  data.sources[0].ownerId=student.id;assert.doesNotThrow(()=>validatePlanningSources(data,student,[sourceId]));
});

test('learning summaries separate first, repeated and later-day performance without other learner data',()=>{
  const data=state();data.topics=[{id:'topic',title:'語彙',subject:'英語',description:'',createdAt:now.toISOString(),targetCount:10}];
  data.questions=[{id:'q',topicId:'topic',prompt:'QUESTION_SECRET',choices:['a','b'],correctIndex:0,explanation:'ANSWER_SECRET',learningPoint:'語彙',sourceIds:[],sourceNote:'',status:'published',version:1,createdAt:now.toISOString()}];
  data.attempts=[
    {id:'a1',userId:student.id,questionId:'q',questionVersion:1,sessionId:'s1',selectedIndex:1,correct:false,answeredAt:'2026-10-20T00:00:00Z'},
    {id:'a2',userId:student.id,questionId:'q',questionVersion:1,sessionId:'s2',selectedIndex:0,correct:true,answeredAt:'2026-10-20T01:00:00Z'},
    {id:'a3',userId:student.id,questionId:'q',questionVersion:1,sessionId:'s3',selectedIndex:1,correct:false,answeredAt:'2026-10-21T00:00:00Z'},
    {id:'a4',userId:other.id,questionId:'q',questionVersion:1,sessionId:'s4',selectedIndex:0,correct:true,answeredAt:'2026-10-21T00:00:00Z'},
  ];
  const result=learningSummary(data,student,'英語',now);
  assert.equal(result.length,1);assert.equal(result[0].first.accuracy,0);assert.equal(result[0].review.accuracy,50);assert.equal(result[0].laterDayReview.accuracy,0);
  assert.equal(result[0].frequentMistakes[0].wrongCount,2);
  assert.doesNotMatch(JSON.stringify(result),/OTHER_PRIVATE_NAME|QUESTION_SECRET|ANSWER_SECRET/);
});

test('planning context uses only chosen sources and this plan history, caps excerpts, and includes extraction uncertainty',()=>{
  const data=state();data.plans[0].sourceIds=[sourceId];
  data.sources=[{id:sourceId,name:'My source',mimeType:'image/jpeg',ownerId:student.id,storagePath:'PRIVATE_DRIVE_PATH',createdAt:now.toISOString()}];
  data.planningTurns=Array.from({length:30},(_,index)=>({...turn,id:`prior-${index}`,version:index+2,status:'complete',message:'m'.repeat(4000),reply:'r'.repeat(10000)}));
  data.planningTurns.push({...turn,id:'private',planId:'another-plan',status:'complete',reply:'OTHER_PRIVATE_REPLY'});
  const events:StudyEvent[]=[{id:`source-analysis:${sourceId}`,type:'source.analysis',actorId:student.id,createdAt:now.toISOString(),payload:{sourceId,text:JSON.stringify({text:'文'.repeat(18000),learningPoints:['語彙'],uncertainties:['一部が判読不可']})}},
    {id:'source-analysis:other',type:'source.analysis',actorId:other.id,createdAt:now.toISOString(),payload:{sourceId:'other',text:'OTHER_PRIVATE_SOURCE'}}];
  const result=buildPlanningContext(data,events,data.plans[0],{...turn,version:40},student,now);
  assert.equal(result.untrustedConversationHistory.length,8);assert.equal(result.untrustedSourceExcerpts.length,1);
  assert.ok(result.untrustedSourceExcerpts[0].analysisExcerpt.length<=9000);
  assert.match(result.untrustedSourceExcerpts[0].analysisExcerpt,/判読不可/);
  assert.ok(JSON.stringify(result).length<50000);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_DRIVE_PATH|OTHER_PRIVATE_REPLY|OTHER_PRIVATE_SOURCE|OTHER_PRIVATE_NAME/);
});

test('AI proposals can use general knowledge but never invent source IDs or unsupported formats',()=>{
  const proposal={title:'語彙10問',subject:'英語',description:'基礎を確認',instructions:'一般的な高校英語の語彙',difficulty:'基礎',targetCount:10,format:'multiple-choice',sourceIds:[]};
  const result=validatePlanningReply({reply:'AIによる案です。',proposals:[proposal]},plan,turn.id);
  assert.equal(result.proposals[0].id,`${turn.id}:0`);assert.deepEqual(result.proposals[0].sourceIds,[]);
  assert.throws(()=>validatePlanningReply({reply:'案',proposals:[{...proposal,sourceIds:[sourceId]}]},plan,turn.id),{code:'INVALID_AI_SOURCE'});
  assert.throws(()=>validatePlanningReply({reply:'案',proposals:[{...proposal,format:'essay'}]},plan,turn.id));
});
