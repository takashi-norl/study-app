import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPersonalPreferences, normalizePersonalPreferences, personalProfileSaveState, personalizedStudyMessage, type PersonalProfile } from '../src/lib/personal-profile';

const profile:PersonalProfile={...defaultPersonalPreferences(),ownerId:'learner',version:1,updatedAt:'2026-10-23T00:00:00Z',nickname:'ユウセイ',enabled:true,
  personalizedMessages:['まず1問、試してみよう。','昨日迷った単語を確かめよう。','できる分だけ、一歩ずつ。']};
test('personalized encouragement requires opt-in, stays stable during a day and prioritizes a break after the target',()=>{
  const date=new Date('2026-10-23T00:00:00Z');
  assert.equal(personalizedStudyMessage(null,{fallback:'いつもの一言'}),'いつもの一言');
  assert.equal(personalizedStudyMessage({...profile,enabled:false},{fallback:'いつもの一言'}),'いつもの一言');
  assert.equal(personalizedStudyMessage(profile,{date}),personalizedStudyMessage(profile,{date:new Date('2026-10-23T10:00:00Z')}));
  assert.ok(profile.personalizedMessages.includes(personalizedStudyMessage(profile,{date})));
  assert.match(personalizedStudyMessage(profile,{todayAnswers:10,dailyTarget:10}),/ひと息/);
  assert.match(personalizedStudyMessage({...profile,personalizedMessages:[],encouragementStyle:'direct'}),/ユウセイさん/);
});


test('profile save stays disabled after confirmation and after edits are reverted', () => {
  assert.deepEqual(personalProfileSaveState(profile, profile), {status:'saved',label:'保存済み',disabled:true});
  const edited = {...profile, goals:'英検準1級に向けて毎日10分'};
  assert.deepEqual(personalProfileSaveState(edited, profile), {status:'changed',label:'変更を保存',disabled:false});
  assert.equal(personalProfileSaveState({...edited,goals:profile.goals}, profile).status, 'saved');
  const sameAfterReload = {...profile,version:5,updatedAt:'2026-10-24T00:00:00Z'};
  assert.equal(personalProfileSaveState(profile, sameAfterReload).disabled, true);
});

test('saved comparison uses server normalization and preserves meaningful message changes', () => {
  const form = {...profile,nickname:`  ${profile.nickname}  `,schoolYear:'  ',personalizedMessages:profile.personalizedMessages.map(message=>` ${message} `).concat(['', '  '])};
  assert.equal(personalProfileSaveState(form, profile).status, 'saved');
  assert.equal(normalizePersonalPreferences(form).nickname, profile.nickname);
  assert.equal(personalProfileSaveState({...form,personalizedMessages:['新しいひとこと']}, profile).status, 'changed');
  assert.equal(personalProfileSaveState({...form,dailyMinutes:NaN}, profile).status, 'changed');
  assert.equal(personalProfileSaveState({...form,enabled:false}, profile).status, 'changed');
});

test('new and AI-drafted preferences are not marked saved before persistence; a failed save stays retryable', () => {
  assert.deepEqual(personalProfileSaveState(defaultPersonalPreferences(), null), {status:'new',label:'プロフィールを保存する',disabled:false});
  const suggestion = {...profile,interests:'サッカーと映画'};
  assert.equal(personalProfileSaveState(suggestion, profile).status, 'changed');
  assert.deepEqual(personalProfileSaveState(suggestion, profile, true), {status:'saving',label:'保存しています',disabled:true});
  // A rejected request leaves the persisted value unchanged; it must remain actionable.
  assert.equal(personalProfileSaveState(suggestion, profile, false).disabled, false);
  assert.equal(personalProfileSaveState(suggestion, suggestion, false).disabled, true);
});
