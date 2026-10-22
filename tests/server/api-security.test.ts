import assert from 'node:assert/strict';
import test from 'node:test';
import { requireGenerationEnabled } from '../../src/server/config';
import { validatePushEndpoint } from '../../src/server/push';
import { assertSameOrigin } from '../../src/server/http';
import { hideQuestionAnswer } from '../../src/server/data';
import type { Question } from '../../src/lib/types';

test('AI is disabled unless explicitly enabled and both provider credentials and model are set',()=>{
  const names=['AI_GENERATION_ENABLED','ANTHROPIC_API_KEY','ANTHROPIC_MODEL'] as const;
  const old=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try {
    for(const name of names) delete process.env[name];
    assert.throws(()=>requireGenerationEnabled(),{code:'AI_DISABLED'});
    process.env.ANTHROPIC_API_KEY='test-only-not-a-real-key';
    process.env.ANTHROPIC_MODEL='test-only-model';
    for(const disabled of ['false','TRUE','1','']) {
      process.env.AI_GENERATION_ENABLED=disabled;
      assert.throws(()=>requireGenerationEnabled(),{code:'AI_DISABLED'});
    }
    process.env.AI_GENERATION_ENABLED='true';
    assert.doesNotThrow(()=>requireGenerationEnabled());
    delete process.env.ANTHROPIC_MODEL;
    assert.throws(()=>requireGenerationEnabled(),{code:'NOT_CONFIGURED'});
  } finally {
    for(const name of names) {if(old[name]===undefined) delete process.env[name];else process.env[name]=old[name];}
  }
});

test('push subscription endpoints reject arbitrary hosts, credentials, insecure schemes and private addresses',()=>{
  for(const url of ['https://fcm.googleapis.com/fcm/send/token','https://web.push.apple.com/token','https://updates.push.services.mozilla.com/wpush/v2/token']) assert.doesNotThrow(()=>validatePushEndpoint(url));
  for(const url of ['http://fcm.googleapis.com/token','https://127.0.0.1/token','https://192.168.3.201/token','https://attacker.example/token','https://fcm.googleapis.com.attacker.example/token','https://fcm.googleapis.com:8443/token','https://user:password@web.push.apple.com/token']) assert.throws(()=>validatePushEndpoint(url));
});

test('mutation origin guard rejects cross-site requests, including a matching forged Origin with cross-site fetch metadata',()=>{
  assert.doesNotThrow(()=>assertSameOrigin(new Request('https://study.example/api/answer',{headers:{origin:'https://study.example','sec-fetch-site':'same-origin'}})));
  assert.throws(()=>assertSameOrigin(new Request('https://study.example/api/answer',{headers:{origin:'https://attacker.example','sec-fetch-site':'cross-site'}})));
  assert.throws(()=>assertSameOrigin(new Request('https://study.example/api/answer',{headers:{origin:'https://study.example','sec-fetch-site':'cross-site'}})));
});

test('practice question projection only returns explicitly approved public fields',()=>{
  const question:Question={id:'q',topicId:'t',prompt:'問題',choices:['選択肢1','選択肢2'],correctIndex:1,explanation:'SECRET',learningPoint:'SECRET',sourceIds:['PRIVATE_ID'],sourceNote:'SECRET',status:'published',version:1,createdAt:'2026-10-22T00:00:00Z',publishedAt:'2026-10-22T00:00:00Z'};
  Object.assign(question,{futurePrivateField:'SECRET'});
  const publicQuestion=hideQuestionAnswer(question);
  assert.equal(publicQuestion.correctIndex,-1);
  assert.equal(JSON.stringify(publicQuestion).includes('SECRET'),false);
  assert.equal(JSON.stringify(publicQuestion).includes('PRIVATE_ID'),false);
  publicQuestion.choices[0]='mutated';
  assert.equal(question.choices[0],'選択肢1');
});
