import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareLearnerDelivery } from '../../src/server/learner-delivery';
import { foldEvents, studyDataForProfile, type StudyEvent } from '../../src/server/google-store';
import { getWorkspaceId } from '../../src/server/env';
import { mayPracticeQuestion } from '../../src/server/practice-access';
import type { Profile, Question } from '../../src/lib/types';
const time='2026-10-23T00:00:00Z';
const operator:Profile={id:'operator',name:'Operator',workspaceId:getWorkspaceId()};
const learner:Profile={...operator,id:'learner',name:'Learner',};
const event=(id:string,type:StudyEvent['type'],payload:unknown):StudyEvent=>({id,type,actorId:operator.id,createdAt:time,payload});

test('delivery is disabled for every account and cannot resume an old receipt',()=>{
  const data=foldEvents([], [operator,learner]);const before=structuredClone(data);
  for(const actor of [operator,learner]) assert.throws(()=>prepareLearnerDelivery(data,[],actor,{topicId:'old-topic',learnerId:learner.id,requestId:'old-receipt'}),{code:'SHARING_DISABLED'});
  assert.deepEqual(data,before);
});

test('the previously delivered 50 questions remain private, editable and practiceable by their owner',()=>{
  const questions:Question[]=Array.from({length:50},(_,i)=>({id:`q-${i}`,topicId:'delivered',planId:'delivered-plan',ownerId:learner.id,audienceUserId:learner.id,
    prompt:`古文の確認${i}`,choices:['一','二','三','四'],correctIndex:i%4,explanation:'自分の問題の解説',learningPoint:'古文単語',sourceIds:[],sourceNote:'既に届いた問題',status:'published',version:1,createdAt:time}));
  const events=[event('questions','questions.published',{questions}),event('plan','plan.created',{id:'delivered-plan',ownerId:learner.id,title:'50問',subject:'古文',goal:'復習',difficulty:'標準',dailyQuestionTarget:10,sourceIds:[],version:1,createdAt:time,updatedAt:time}),
    event('topic','topic.created',{id:'delivered',planId:'delivered-plan',ownerId:learner.id,audienceUserId:learner.id,title:'50問',subject:'古文',description:'既存の本人用コピー',targetCount:50,createdAt:time})];
  const data=foldEvents(events,[operator,learner]);
  const own=studyDataForProfile(data,learner);
  assert.equal(own.questions.length,50);assert.equal(own.plans.length,1);assert.equal(own.questions[0].explanation,'自分の問題の解説');
  assert.ok(data.questions.every(question=>mayPracticeQuestion(data,learner,question)));
  assert.equal(studyDataForProfile(data,operator).questions.length,0);
  assert.equal(studyDataForProfile(data,{...learner,id:'friend'}).questions.length,0);
  assert.deepEqual(data.questions.map(q=>q.id),questions.map(q=>q.id));
});
