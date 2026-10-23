import assert from 'node:assert/strict';
import test from 'node:test';
import { checkVocabularyBuildQuota } from '../../src/server/vocabulary-build-budget';
import { checkAudioQuota } from '../../src/server/audio';
import type { StudyEvent } from '../../src/server/google-store';
const catalog = Array.from({length:100}, (_,i)=>({cacheKey:i.toString(16).padStart(64,'0'),characters:250}));
const events: StudyEvent[] = Array.from({length:30},(_,i)=>({id:`paid-${i}`,type:'audio.requested',actorId:'admin',createdAt:new Date().toISOString(),payload:{cacheKey:`past-${i}`,characters:250}}));
test('a bounded one-time catalog may finish its 100 clips without changing the daily practice limit',()=>{
  assert.throws(()=>checkAudioQuota(events,250),{code:'AUDIO_LIMIT'});
  assert.doesNotThrow(()=>checkVocabularyBuildQuota(events,catalog,catalog[0].cacheKey));
  assert.throws(()=>checkVocabularyBuildQuota(events,catalog.slice(0,99),catalog[0].cacheKey),{code:'VOCABULARY_BUILD_BUDGET'});
  assert.throws(()=>checkVocabularyBuildQuota(events,catalog,'unknown'),{code:'VOCABULARY_BUILD_BUDGET'});
  assert.throws(()=>checkVocabularyBuildQuota(events,catalog.map(x=>({...x,characters:400})),catalog[0].cacheKey),{code:'VOCABULARY_BUILD_BUDGET'});
});
test('catalog budget still counts failed reservations and monthly paid requests',()=>{
  const already=[...events,{...events[0],id:'already',payload:{cacheKey:catalog[0].cacheKey,characters:250}}];
  assert.throws(()=>checkVocabularyBuildQuota(already,catalog,catalog[0].cacheKey),{code:'AUDIO_PENDING'});
  const full=Array.from({length:300},(_,i)=>({...events[0],id:`month-${i}`}));
  assert.throws(()=>checkVocabularyBuildQuota(full,catalog,catalog[0].cacheKey),{code:'AUDIO_LIMIT'});
});
