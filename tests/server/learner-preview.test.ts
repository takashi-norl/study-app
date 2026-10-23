import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareLearnerPreview } from '../../src/server/learner-preview';
import { foldEvents } from '../../src/server/google-store';
import { getFamilyId } from '../../src/server/env';
import type { Profile } from '../../src/lib/types';

test('learner preview is disabled for all identities, including self-preview, without changing records',()=>{
  const parent:Profile={id:'parent',name:'Parent',familyId:getFamilyId(),role:'parent'};
  const learner:Profile={...parent,id:'learner',name:'Learner',role:'student'};
  const data=foldEvents([],[parent,learner]);const before=structuredClone(data);
  for(const actor of [parent,learner,{...parent,familyId:'foreign'}]) for(const target of [parent.id,learner.id,'unknown']) {
    assert.throws(()=>prepareLearnerPreview(data,actor,target),{status:410,code:'SHARING_DISABLED'});
  }
  assert.deepEqual(data,before);
});
