import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearningPlan, PlanningSample, PlanningTurn, Profile, StudyData, Topic, GenerationJob } from '../../src/lib/types';
import { createPlanSchema, buildPlanningContext, validatePlanningReply } from '../../src/server/planning';
import { buildQuestionGenerationPrompt } from '../../src/server/generation';
import { materializeQuestions } from '../../src/server/generated-batch';
import { foldEvents, type StudyEvent } from '../../src/server/google-store';
import { preparePlanArrangement } from '../../src/server/plan-arrangement';
import { assertGenerationAccess, currentApprovedProposal } from '../../src/server/proposal-selection';
import { prepareGenerationRetry } from '../../src/server/generation-retry';
import { getWorkspaceId } from '../../src/server/env';

const now='2026-10-24T00:00:00.000Z';
const sourceId='12345678-1234-4234-8234-123456789abc';
const profile:Profile={id:'owner',workspaceId:getWorkspaceId(),name:'Learner',};
const plan:LearningPlan={id:'plan',ownerId:profile.id,title:'古文単語',subject:'古文',questionTemplate:'kobun-vocabulary',goal:'教材の範囲を覚える',difficulty:'基礎',sourceIds:[sourceId],dailyQuestionTarget:10,version:2,createdAt:now,updatedAt:now};
const samples:PlanningSample[]=['まもる','あそぶ','めづ'].map((word,i)=>({prompt:`【意味】古文単語「${word}」の意味として適切なものを選びなさい。`,
  choices:[['じっと見つめる','管絃を楽しむ','ほめる'][i],'歩き回る','怒り散らす','隠れて待つ'],correctIndex:0,
  explanation:'教材の見出しにある意味を確認する問題です。現代語で思い浮かべる意味と区別し、教材に記された場面を手がかりに覚えましょう。',
  learningPoint:`古文単語｜${word}`,sourceIds:[sourceId],sourceNote:'教材の見出しと語義。',needsReview:false}));
const raw={reply:'読めた三つの語を試します。',proposals:[{title:'古文単語の基本',subject:'古文',description:'教材の語義を確認する。',instructions:'やさしくする。',difficulty:'基礎',targetCount:10,format:'multiple-choice' as const,sourceIds:[sourceId],samples}]};
const proposal=validatePlanningReply(raw,plan,'turn').proposals[0];
const turn:PlanningTurn={id:'turn',planId:plan.id,requestedBy:profile.id,version:2,status:'complete',message:'短くして',reply:raw.reply,proposals:[proposal],createdAt:now};
const topic:Topic={id:'topic',ownerId:profile.id,audienceUserId:profile.id,planId:plan.id,title:'古文単語の基本',subject:'古文',questionTemplate:'kobun-vocabulary',description:'',targetCount:10,createdAt:now};
const job:GenerationJob={id:'job',topicId:topic.id,planId:plan.id,requestedBy:profile.id,audienceUserId:profile.id,questionTemplate:'kobun-vocabulary',status:'failed',targetCount:10,generatedCount:0,sourceIds:[sourceId],approvedSamples:proposal.samples,approvedSampleVersion:2,approvedInstructions:proposal.instructions,proposalId:proposal.id,turnId:turn.id,createdAt:now};
const event=(id:string,type:StudyEvent['type'],payload:unknown):StudyEvent=>({id,type,payload,actorId:profile.id,createdAt:now});
function fixture():StudyData{return {plans:[structuredClone(plan)],planningTurns:[structuredClone(turn)],topics:[structuredClone(topic)],jobs:[structuredClone(job)],profiles:[profile],questions:[],attempts:[],exposures:[],sessions:[],sources:[{id:sourceId,ownerId:profile.id,name:'古文単語の教材',storagePath:'private-file',mimeType:'image/png',createdAt:now}]};}

test('direct template creation requires classical Japanese and an actual selected source while old plans are compatible',()=>{
  const input={subject:'古文',goal:'単語を覚える',sourceIds:[sourceId],questionTemplate:'kobun-vocabulary'};
  assert.equal(createPlanSchema.parse(input).questionTemplate,'kobun-vocabulary');
  assert.equal(createPlanSchema.safeParse({...input,sourceIds:[]}).success,false);
  assert.equal(createPlanSchema.safeParse({...input,subject:'英語'}).success,false);
  assert.equal(createPlanSchema.parse({subject:'英語',goal:'英単語を覚える'}).questionTemplate,undefined);
});

test('the mode survives the event store, later conversations, bulk approval and recovery',()=>{
  const data=foldEvents([event('plan','plan.created',plan),event('topic','topic.created',topic),event('job','job.upserted',job)], [profile]);
  assert.equal(data.plans[0].questionTemplate,'kobun-vocabulary');
  assert.equal(data.topics[0].questionTemplate,'kobun-vocabulary');
  assert.equal(data.jobs[0].questionTemplate,'kobun-vocabulary');
  const full=fixture();
  const context=buildPlanningContext(full,[event(`source-analysis:${sourceId}`,'source.analysis',{sourceId,text:JSON.stringify({text:'まもる＝じっと見つめる',learningPoints:['まもる'],uncertainties:[]})})],plan,{...turn,message:'もっとわかりやすく'},profile);
  assert.equal(context.plan.questionTemplate,'kobun-vocabulary');
  assert.equal(currentApprovedProposal(full,profile,plan.id,{expectedVersion:2,turnId:turn.id,proposalId:proposal.id,approveSamples:true}).plan.questionTemplate,'kobun-vocabulary');
  const retry=prepareGenerationRetry(full,profile,job.id,'retry-request',new Date(now),'retry-job');
  assert.equal(retry.job.questionTemplate,'kobun-vocabulary');
  assert.deepEqual(retry.job.approvedSamples,proposal.samples);
  assert.throws(()=>assertGenerationAccess(full,{...job,questionTemplate:undefined}),{code:'GENERATION_ACCESS_DENIED'});
});

test('samples keep word grouping, rebalance choices, and cannot switch subject or drop material evidence',()=>{
  assert.equal(new Set(proposal.samples!.map(q=>q.correctIndex)).size,3);
  proposal.samples!.forEach((q,i)=>assert.equal(q.choices[q.correctIndex],samples[i].choices[0]));
  assert.throws(()=>validatePlanningReply({...raw,proposals:[{...raw.proposals[0],subject:'英語'}]},plan,'turn'),{code:'INVALID_VOCABULARY_QUESTION'});
  assert.throws(()=>validatePlanningReply({...raw,proposals:[{...raw.proposals[0],sourceIds:[],samples:samples.map(q=>({...q,sourceIds:[]}))}]},plan,'turn'),{code:'INVALID_VOCABULARY_QUESTION'});
  assert.throws(()=>validatePlanningReply({...raw,proposals:[{...raw.proposals[0],samples:samples.map(q=>({...q,needsReview:true}))}]},plan,'turn'),{code:'INVALID_VOCABULARY_QUESTION'});
  assert.deepEqual(validatePlanningReply({reply:'教材が読めないため、撮り直してください。',proposals:[]},plan,'turn').proposals,[]);
});

test('bulk keeps canonical mode and coverage despite abbreviated AI instructions, and saves balanced original answers',()=>{
  const prompt=buildQuestionGenerationPrompt({questionTemplate:'kobun-vocabulary',subject:'古文',title:'基本',count:2,existing:[],existingVocabulary:samples,
    approvedInstructions:'短くして',approvedSamples:proposal.samples,sources:[{id:sourceId,name:'教材',text:'読み取った語義'}]});
  assert.equal(prompt.questionTemplate,'kobun-vocabulary');
  assert.deepEqual(prompt.vocabularyCoverage,samples.map(q=>({learningPoint:q.learningPoint,count:1})));
  const prior=materializeQuestions(samples.slice(0,2),{job,sourceIds:[sourceId],prior:[],count:2,createdAt:now});
  const next=materializeQuestions(samples.slice(2),{job,sourceIds:[sourceId],prior,count:1,createdAt:now});
  assert.ok(!prior.some(q=>q.correctIndex===next[0].correctIndex));
  assert.equal(next[0].choices[next[0].correctIndex],samples[2].choices[0]);
  assert.throws(()=>materializeQuestions([{...samples[2],needsReview:true}],{job,sourceIds:[sourceId],prior:[],count:1,createdAt:now}));
  const english=buildQuestionGenerationPrompt({subject:'英語',title:'Words',count:2,sources:[],existing:[]});
  assert.equal(english.questionTemplate,undefined);assert.equal(english.vocabularyCoverage,undefined);
});

test('public arrangements are no longer available, including old source-free clones',()=>{
  const data=fixture();data.jobs=[];
  data.topics[0]={...topic,libraryPublished:true,librarySourceTopicId:'hidden-original',planId:undefined,audienceUserId:undefined,ownerId:undefined};
  data.questions=materializeQuestions(samples,{job,sourceIds:[sourceId],prior:[],count:3,createdAt:now}).map(q=>({...q,ownerId:undefined,audienceUserId:undefined,sourceIds:[],planId:undefined}));
  assert.throws(()=>preparePlanArrangement(data,profile,topic.id,'forbidden',new Date()),{code:'TOPIC_NOT_FOUND'});
});
