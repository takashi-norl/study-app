import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { defaultPersonalPreferences } from '../../src/lib/personal-profile';
import { ApiError } from '../../src/server/config';
import { foldEvents, type StudyEvent } from '../../src/server/google-store';
import { buildPersonalProfileContext, chatPersonalProfile, confirmedProfileContext, foldPersonalProfile,
  PERSONAL_PROFILE_SYSTEM_PROMPT, personalProfileState, savePersonalProfile } from '../../src/server/personal-profile';
import { personalProfileReplySchema, personalProfileSaveSchema } from '../../src/server/personal-profile-schemas';

const at = '2026-10-23T00:00:00.000Z';
const now = () => new Date(at);
const owner = {id:'learner-one'};
const prefs = {...defaultPersonalPreferences(),nickname:'ユウセイ',schoolYear:'高校1年',goals:'英検準1級の語彙',enabled:true};
const reply = {reply:'目標に合わせて、まずは10分を目安に進めましょう。',draft:{...prefs,personalizedMessages:['まず1問、意味を確かめよう。','10分を目安に、できる分だけ。','今日はここまででも大丈夫。']}};
const saved = (ownerId:string,expectedVersion=0,preferences=prefs):StudyEvent => ({id:randomUUID(),actorId:ownerId,type:'personal-profile.saved',createdAt:at,
  payload:{ownerId,requestId:randomUUID(),expectedVersion,preferences}});
function harness(seed:StudyEvent[] = []) {
  const events = [...seed]; let calls=0;
  const deps = {load:async()=>structuredClone(events),append:async(incoming:StudyEvent[])=>{events.push(...structuredClone(incoming));},now,uuid:randomUUID,ensureAi:()=>{},
    requestReply:async()=>{calls+=1;return structuredClone(reply);}};
  return {events,deps,calls:()=>calls};
}

test('personal profile state exposes only the requesting owner, even for managers and superusers',()=>{
  const data = [saved('learner-one'),saved('manager',0,{...prefs,nickname:'PRIVATE_MANAGER'}),saved('superuser',0,{...prefs,nickname:'PRIVATE_SUPER'})];
  const state = personalProfileState(data,owner.id,now());
  assert.equal(state.profile?.nickname,'ユウセイ');
  assert.equal(JSON.stringify(state).includes('PRIVATE_'),false);
  assert.equal(personalProfileState(data,'new-user',now()).profile,null);
  assert.equal(confirmedProfileContext(data,'manager')?.nickname,'PRIVATE_MANAGER');
  assert.equal(confirmedProfileContext(data,'new-user'),undefined);
  assert.equal(confirmedProfileContext([saved('learner-one',0,{...prefs,enabled:false})],owner.id),undefined);
  const forged = {...saved(owner.id),actorId:'manager'};
  assert.equal(personalProfileState([forged],owner.id,now()).profile,null);
  // The shared study-state projection never includes this separate private event stream.
  assert.equal(JSON.stringify(foldEvents(data)).includes('PRIVATE_'),false);
});

test('manual changes require the current version, reject overposting, and retry without changing the version',async()=>{
  const h=harness();
  const input={requestId:randomUUID(),expectedVersion:0,preferences:prefs};
  const first=await savePersonalProfile(owner,input,h.deps);
  assert.equal(first.version,1);assert.equal(first.profile?.enabled,true);assert.equal(h.calls(),0);
  assert.equal((await savePersonalProfile(owner,input,h.deps)).version,1);
  await assert.rejects(savePersonalProfile(owner,{...input,preferences:{...prefs,nickname:'別の名前'}},h.deps),(error:unknown)=>error instanceof ApiError && error.code==='REQUEST_CONFLICT');
  await assert.rejects(savePersonalProfile(owner,{...input,requestId:randomUUID()},h.deps),(error:unknown)=>error instanceof ApiError && error.code==='STALE_PROFILE');
  assert.equal(personalProfileSaveSchema.safeParse({...input,ownerId:'manager'}).success,false);
  assert.equal(personalProfileSaveSchema.safeParse({...input,preferences:{...prefs,personalityDiagnosis:'unwanted'}}).success,false);
});

test('AI conversation produces a draft only; saving it is an explicit separate operation',async()=>{
  const h=harness();
  const input={requestId:randomUUID(),expectedVersion:0,message:'英検準1級を目指して、毎日10分やりたい'};
  const state=await chatPersonalProfile(owner,input,h.deps);
  assert.equal(state.version,1);assert.equal(state.profile,null);
  assert.equal(state.turns[0].status,'complete');assert.equal(state.turns[0].draft?.goals,prefs.goals);assert.equal(h.calls(),1);
  assert.equal(confirmedProfileContext(h.events,owner.id),undefined);
  assert.equal((await chatPersonalProfile(owner,input,h.deps)).turns[0].reply,reply.reply);assert.equal(h.calls(),1);
  const confirmed=await savePersonalProfile(owner,{requestId:randomUUID(),expectedVersion:state.version,preferences:state.turns[0].draft},h.deps);
  assert.equal(confirmed.profile?.goals,prefs.goals);assert.equal(confirmed.profile?.version,2);
});

test('concurrent identical retries invoke AI once and concurrent different requests cannot win the same version',async()=>{
  const h=harness();
  const input={requestId:randomUUID(),expectedVersion:0,message:'一緒に目標を決めたい'};
  await Promise.all([chatPersonalProfile(owner,input,h.deps),chatPersonalProfile(owner,input,h.deps)]);
  assert.equal(h.calls(),1);
  assert.equal(personalProfileState(h.events,owner.id,now()).turns.length,1);
  const g=harness();
  const outcomes=await Promise.allSettled([chatPersonalProfile(owner,input,g.deps),chatPersonalProfile(owner,{...input,requestId:randomUUID(),message:'異なる相談'},g.deps)]);
  assert.equal(outcomes.filter(result=>result.status==='rejected').length,1);assert.equal(g.calls(),1);
});

test('failed and abandoned requests never trigger paid retries and manual preferences remain editable',async()=>{
  const h=harness();
  const input={requestId:randomUUID(),expectedVersion:0,message:'自分に合う進め方を相談したい'};
  let attempts=0;
  const deps={...h.deps,requestReply:async()=>{attempts+=1;throw new Error('SECRET_PROVIDER_ERROR');}};
  const failed=await chatPersonalProfile(owner,input,deps);
  assert.equal(failed.turns[0].status,'failed');assert.equal(JSON.stringify(failed).includes('SECRET_PROVIDER_ERROR'),false);
  await chatPersonalProfile(owner,input,deps);assert.equal(attempts,1);
  const savedState=await savePersonalProfile(owner,{requestId:randomUUID(),expectedVersion:failed.version,preferences:prefs},deps);
  assert.equal(savedState.profile?.goals,prefs.goals);
  const pending=h.events.filter(event=>event.type==='personal-profile.chat.requested');
  assert.equal(personalProfileState(pending,owner.id,new Date(Date.parse(at)+300_001)).turns[0].status,'failed');
});

test('only the reserved execution can complete a conversation and later results do not overwrite it',()=>{
  const requestId=randomUUID(), executionToken=randomUUID();
  const request:StudyEvent={id:'request',type:'personal-profile.chat.requested',actorId:owner.id,createdAt:at,
    payload:{ownerId:owner.id,requestId,executionToken,expectedVersion:0,message:'短い声かけがいい'}};
  const result=(id:string,token:string,value=reply.reply):StudyEvent=>({id,type:'personal-profile.chat.completed',actorId:owner.id,createdAt:at,
    payload:{ownerId:owner.id,requestId,executionToken:token,version:1,reply:value,draft:reply.draft}});
  const events=[request,result('wrong-token',randomUUID(),'INVALID_REPLY'),result('right-token',executionToken),result('late',executionToken,'LATE_REPLY')];
  const state=personalProfileState(events,owner.id,now());
  assert.equal(state.turns[0].reply,reply.reply);
  assert.equal(state.profile,null);
});

test('per-person daily allowance counts accepted failed calls too and allows manual editing after the limit',async()=>{
  const h=harness();
  for(let index=0;index<8;index+=1) await chatPersonalProfile(owner,{requestId:randomUUID(),expectedVersion:index,message:`相談 ${index}`},
    index===0 ? {...h.deps,requestReply:async()=>{throw new Error('Provider unavailable');}} : h.deps);
  await assert.rejects(chatPersonalProfile(owner,{requestId:randomUUID(),expectedVersion:8,message:'もう一度'},h.deps),
    (error:unknown)=>error instanceof ApiError && error.code==='PROFILE_DAILY_LIMIT');
  assert.equal(h.calls(),7);
  assert.equal((await savePersonalProfile(owner,{requestId:randomUUID(),expectedVersion:8,preferences:prefs},h.deps)).version,9);
});

test('context is bounded, excludes another person, and the inference contract forbids sensitive labels and coercion',async()=>{
  const h=harness([saved('manager',0,{...prefs,nickname:'SECRET_MANAGER'})]);
  for(let index=0;index<8;index+=1) await chatPersonalProfile(owner,{requestId:randomUUID(),expectedVersion:index,message:`会話 ${index}`},h.deps);
  const context=buildPersonalProfileContext(h.events,owner.id,'新しい質問',now());
  assert.equal(context.confirmedPreferences,null);assert.equal(context.untrustedConversationHistory.length,6);
  assert.equal(JSON.stringify(context).includes('SECRET_MANAGER'),false);
  assert.equal(context.untrustedCurrentMessage,'新しい質問');
  assert.match(PERSONAL_PROFILE_SYSTEM_PROMPT,/敏感な属性を推測・分類してはいけません/);
  assert.match(PERSONAL_PROFILE_SYSTEM_PROMPT,/罪悪感/);
  assert.match(PERSONAL_PROFILE_SYSTEM_PROMPT,/休む・別日に続ける/);
  assert.equal(personalProfileReplySchema.safeParse({...reply,draft:{...reply.draft,personality:'diagnosis'}}).success,false);
  assert.equal(personalProfileReplySchema.safeParse({...reply,draft:{...reply.draft,personalizedMessages:['a'.repeat(101),'b','c']}}).success,false);
  assert.equal(foldPersonalProfile(h.events,owner.id,now()).state.turns.length,8);
});
