import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPersonalPreferences, personalizedStudyMessage, type PersonalProfile } from '../src/lib/personal-profile';

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
