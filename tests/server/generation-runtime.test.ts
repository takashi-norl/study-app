import assert from 'node:assert/strict';
import test from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { aiFailureDiagnostic, anthropicRequestPolicy } from '../../src/server/ai-usage';
import { assertGenerationCallNotSent, generatedBatchSchema, generateQuestions, safeGenerationError } from '../../src/server/generation';
import type { StudyEvent } from '../../src/server/google-store';

test('question generation gets a bounded longer response window without enabling paid retries for any feature',()=>{
  assert.equal(anthropicRequestPolicy('question-generation').timeout,180_000);
  for(const feature of ['source-analysis','planning','profile'] as const)assert.equal(anthropicRequestPolicy(feature).timeout,90_000);
  for(const feature of ['question-generation','source-analysis','planning','profile'] as const)assert.equal(anthropicRequestPolicy(feature).maxRetries,0);
});

test('timeout, connection, service, and format failures have distinct safe explanations without provider details',()=>{
  const privateText='PRIVATE_PROVIDER_BODY_AND_API_TOKEN';
  const timeout=new Anthropic.APIConnectionTimeoutError({message:privateText});
  const connection=new Anthropic.APIConnectionError({message:privateText});
  const service=Anthropic.APIError.generate(529,{error:{message:privateText}},privateText,new Headers());
  const format=z.object({text:z.string()}).safeParse({text:123});
  assert.equal(format.success,false);
  if(format.success)throw new Error('Expected invalid fixture');
  const messages=[safeGenerationError(timeout),safeGenerationError(connection),safeGenerationError(service),safeGenerationError(format.error)];
  assert.match(messages[0],/制限時間/);
  assert.match(messages[1],/通信/);
  assert.match(messages[2],/サービス側/);
  assert.match(messages[3],/形式/);
  assert.equal(new Set(messages).size,4);
  for(const message of [...messages,safeGenerationError(new Error(privateText))])assert.equal(message.includes(privateText),false);
});

test('private diagnostics identify operational failure kinds but exclude raw error data',()=>{
  const privateText='PRIVATE_PROVIDER_BODY_PROMPT_AND_HEADERS';
  const invocationId='3825f75a-55cf-41fd-b035-965c0d5dc4f7';
  const examples=[
    {error:new Anthropic.APIConnectionTimeoutError({message:privateText}),kind:'timeout'},
    {error:new Anthropic.APIConnectionError({message:privateText,cause:new Error(privateText)}),kind:'connection'},
    {error:Anthropic.APIError.generate(529,{error:{message:privateText}},privateText,new Headers({'x-private':privateText})),kind:'provider'},
    {error:Object.assign(new Error(privateText),{body:privateText,status:503}),kind:'unexpected'},
  ];
  for(const {error,kind} of examples) {
    const diagnostic=aiFailureDiagnostic('question-generation',invocationId,error);
    assert.equal(diagnostic.kind,kind);
    assert.equal(diagnostic.timeoutMs,180_000);
    assert.equal(diagnostic.invocationId,invocationId);
    assert.deepEqual(Object.keys(diagnostic).sort(),kind==='provider'
      ?['feature','httpStatus','invocationId','kind','timeoutMs']:['feature','invocationId','kind','timeoutMs']);
    assert.equal(diagnostic.httpStatus,kind==='provider'?529:undefined);
    assert.equal(JSON.stringify(diagnostic).includes(privateText),false);
  }
});

test('an uncertain paid batch or source receipt blocks repeat calls under that logical identity',()=>{
  for(const feature of ['question-generation','source-analysis'] as const) {
    const context={actorId:'owner',feature,requestId:`generation:job:${feature==='source-analysis'?'source:page':'batch:0'}`};
    const receipt:StudyEvent={id:'receipt',type:'ai.requested',actorId:'owner',createdAt:'2026-10-23T00:00:00Z',payload:{feature,requestId:context.requestId}};
    assert.throws(()=>assertGenerationCallNotSent([receipt],context),{code:'GENERATION_RESULT_UNCERTAIN'});
    assert.throws(()=>assertGenerationCallNotSent([receipt,{...receipt,id:'failure',type:'ai.usage',payload:{...receipt.payload,status:'failed'}}],context),{code:'GENERATION_RESULT_UNCERTAIN'});
    assert.doesNotThrow(()=>assertGenerationCallNotSent([receipt],{...context,requestId:'generation:new-explicit-job:batch:0'}));
    assert.doesNotThrow(()=>assertGenerationCallNotSent([{...receipt,actorId:'another-owner'}],context));
  }
});

test('oversized generation requests are rejected before any provider request and output validation stays bounded',async()=>{
  await assert.rejects(generateQuestions({title:'古文',subject:'国語',count:20,sources:[],existing:[]},
    {actorId:'owner',feature:'question-generation',requestId:'no-paid-call'}),{code:'INVALID_BATCH_SIZE'});
  const question={prompt:'次の語の意味を選びなさい。',choices:['A','B','C','D'],correctIndex:0,explanation:'この語はAの意味です。',learningPoint:'語彙',sourceIds:[],sourceNote:'一般知識',needsReview:false};
  assert.equal(generatedBatchSchema.safeParse({questions:Array(10).fill(question)}).success,true);
  assert.equal(generatedBatchSchema.safeParse({questions:Array(11).fill(question)}).success,false);
});
