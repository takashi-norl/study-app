import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareLearnerPreview } from '../../src/server/learner-preview';
import { foldEvents } from '../../src/server/google-store';
import { getWorkspaceId } from '../../src/server/env';
import type { Profile } from '../../src/lib/types';

test('learner preview is disabled for all identities, including self-preview, without changing records',()=>{
  const operator:Profile={id:'operator',name:'Operator',workspaceId:getWorkspaceId(),};
  const learner:Profile={...operator,id:'learner',name:'Learner',};
  const data=foldEvents([],[operator,learner]);const before=structuredClone(data);
  for(const actor of [operator,learner,{...operator,workspaceId:'foreign'}]) for(const target of [operator.id,learner.id,'unknown']) {
    assert.throws(()=>prepareLearnerPreview(data,actor,target),{status:410,code:'SHARING_DISABLED'});
  }
  assert.deepEqual(data,before);
});
