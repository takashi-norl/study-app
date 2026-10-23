import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveBulkVolume} from '../src/lib/sample-volume';

test('bulk total remains unset until the learner selects it',()=>{
  assert.equal(resolveBulkVolume({mode:'total',total:null}).valid,false);
  assert.deepEqual(resolveBulkVolume({mode:'total',total:100}),{valid:true,total:100});
});
test('day-based volume is exact, bounded and does not quietly clamp a user choice',()=>{
  assert.deepEqual(resolveBulkVolume({mode:'schedule',days:7,daily:10}),{valid:true,total:70});
  assert.deepEqual(resolveBulkVolume({mode:'schedule',days:30,daily:10}),{valid:true,total:300});
  for(const [days,daily] of [[31,10],[0,10],[1.5,10],[7,0],[7,2.5],[Infinity,10],[NaN,10]]) assert.equal(resolveBulkVolume({mode:'schedule',days,daily}).valid,false);
  for(const total of [0,301,-1,2.5,NaN,Infinity]) assert.equal(resolveBulkVolume({mode:'total',total}).valid,false);
});
