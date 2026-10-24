import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJob, LearningPlan, PlanningSample, PlanningTurn, Profile, Topic } from '../../src/lib/types';
import { buildQuestionGenerationPrompt } from '../../src/server/generation';
import { materializeQuestions } from '../../src/server/generated-batch';
import { anthropicRequestPolicy } from '../../src/server/ai-usage';
import { assertGenerationAccess, validateBulkCadence } from '../../src/server/proposal-selection';
import { foldEvents, type StudyEvent } from '../../src/server/google-store';
import { getWorkspaceId } from '../../src/server/env';

const samples:PlanningSample[]=Array.from({length:3},(_,i)=>({prompt:`Select the meaning of example ${i+1}.`,choices:['A','B','C','D'],correctIndex:i,
  explanation:'This explanation is the approved style.',learningPoint:'Vocabulary',sourceIds:[],sourceNote:'AI-created example',needsReview:false}));
const now='2026-10-23T00:00:00Z';
const profile:Profile={id:'owner',workspaceId:getWorkspaceId(),name:'Owner',};
const plan:LearningPlan={id:'plan',ownerId:profile.id,title:'Words',subject:'英語',goal:'Vocabulary',difficulty:'Advanced',dailyQuestionTarget:10,sourceIds:[],sampleFirst:true,version:1,createdAt:now,updatedAt:now};
const instructions='作問の具体的な条件。'.repeat(350).slice(0,3900)+'\n現代語訳を設問に付けない。';
const turn:PlanningTurn={id:'turn',planId:plan.id,requestedBy:profile.id,version:2,status:'queued',message:'この形式の問題を試す',samplePreview:true,createdAt:now};
const proposal={id:'turn:0',title:'Words',subject:'英語',description:'Vocabulary practice',instructions,difficulty:'Advanced',targetCount:10,format:'multiple-choice' as const,sourceIds:[],samples};
const topic:Topic={id:'topic',ownerId:profile.id,title:'Words',subject:'英語',description:'Vocabulary',createdAt:now,targetCount:100,planId:plan.id,audienceUserId:profile.id};
const job:GenerationJob={id:'job',topicId:topic.id,requestedBy:profile.id,status:'queued',createdAt:now,targetCount:100,generatedCount:0,planId:plan.id,turnId:turn.id,proposalId:proposal.id,audienceUserId:profile.id,sourceIds:[],approvedSamples:samples,approvedSampleVersion:2,approvedInstructions:instructions,dailyQuestionTarget:5,plannedDays:20};
const event=(id:string,type:StudyEvent['type'],payload:unknown):StudyEvent=>({id,type,payload,actorId:profile.id,createdAt:now});
const before=[event('plan','plan.created',plan),event('turn','planning.turn.upserted',turn),event('complete','planning.turn.upserted',{...turn,status:'complete',proposals:[proposal],reply:'Please check these three.'})];

test('accepted generation atomically stores the chosen total and cadence alongside exact approval snapshots',()=>{
  const queued=event('slot','generation.requested',{topic,job,updatedPlan:{...plan,version:3,requestedQuestionCount:100,dailyQuestionTarget:5,plannedDays:20}});
  const data=foldEvents([...before,queued,queued],[profile]);
  assert.equal(data.plans[0].version,3);
  assert.equal(data.plans[0].dailyQuestionTarget,5);
  assert.equal(data.plans[0].requestedQuestionCount,100);
  assert.equal(data.plans[0].plannedDays,20);
  assert.equal(data.jobs.length,1);
  assert.deepEqual(data.jobs[0].approvedSamples,samples);
  assert.equal(data.jobs[0].approvedInstructions,instructions);
  assert.equal(data.questions.length,0);
  assert.equal(data.planningTurns[0].samplePreview,true);
  assert.equal(assertGenerationAccess(data,data.jobs[0]).id,profile.id);
  assert.throws(()=>assertGenerationAccess(data,{...data.jobs[0],approvedInstructions:'Different conditions'}),{code:'GENERATION_ACCESS_DENIED'});
  assert.equal(foldEvents(before,[profile]).plans[0].dailyQuestionTarget,10);
});

test('bulk prompt preserves all approved instructions and actual samples without allowing the preview questions to be saved again',()=>{
  const prompt=buildQuestionGenerationPrompt({title:'Words',subject:'英語',count:10,sources:[],existing:[],instructions:'Old truncated condition',approvedInstructions:instructions,approvedSamples:samples});
  assert.equal(prompt.arrangement,instructions);
  assert.deepEqual(prompt.untrustedApprovedSamples,samples);
  assert.match(prompt.approvedSamplePolicy!,/承認/);
  assert.match(prompt.approvedSamplePolicy!,/今回渡された資料/);
  assert.match(prompt.arrangement!,/現代語訳を設問に付けない。$/);
  const candidate={...samples[0],sourceNote:'AI example'};
  const stored=materializeQuestions([candidate,{...candidate,prompt:'A genuinely different practice question.'}],{job,sourceIds:[],prior:[],excludedPrompts:samples.map(q=>q.prompt),count:10,createdAt:now});
  assert.equal(stored.length,1);
  assert.notEqual(stored[0].prompt,samples[0].prompt);
});

test('daily times days must match the paid total, and only explicit sample planning gets the longer provider deadline',()=>{
  assert.doesNotThrow(()=>validateBulkCadence(100,5,20));
  assert.doesNotThrow(()=>validateBulkCadence(30));
  for(const input of [[100,10,20],[301,1,301],[0,5,0],[10,undefined,10],[10,101,1]] as const) {
    assert.throws(()=>validateBulkCadence(input[0],input[1],input[2]),error=>!!error && typeof error==='object' && 'status' in error && error.status===400);
  }
  assert.deepEqual(anthropicRequestPolicy('planning'),{timeout:90000,maxRetries:0});
  assert.deepEqual(anthropicRequestPolicy('planning',true),{timeout:180000,maxRetries:0});
  assert.deepEqual(anthropicRequestPolicy('source-analysis',true),{timeout:90000,maxRetries:0});
});
