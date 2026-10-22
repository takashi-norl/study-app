import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSources,plannedBatchCount,countForBatch,promptBudget } from '../src/server/generation-plan';

test('20 long photos are grouped into bounded requests without losing source text or citation IDs',()=>{
  const sources=Array.from({length:20},(_,index)=>({id:`source-${index}`,name:`資料${index}`,text:'あ'.repeat(50000)}));
  const groups=groupSources(sources);
  assert.ok(groups.length>1);
  for(const group of groups) assert.ok(JSON.stringify(group).length<=75000);
  for(const source of sources) assert.equal(groups.flat().filter(s=>s.id===source.id).map(s=>s.text).join(''),source.text);
  assert.deepEqual(groupSources(sources),groups);
});

test('100-question allocation visits every source group and never asks for more than 20 at once',()=>{
  const groupCount=20;
  const batches=plannedBatchCount(100,groupCount);
  let remaining=100;
  const covered=new Set<number>();
  for(let batch=0;batch<batches;batch++) {
    const count=countForBatch(remaining,batch,batches);
    assert.ok(count>0 && count<=20);
    covered.add(batch%groupCount);
    remaining-=count;
  }
  assert.equal(remaining,0);
  assert.equal(covered.size,groupCount);
});

test('context budget stays bounded as a topic gains many questions',()=>{
  const prompts=Array.from({length:1000},(_,index)=>`${index}:`+'問'.repeat(2000));
  const selected=promptBudget(prompts);
  assert.ok(selected.join('').length<=20000);
  assert.ok(selected.every(prompt=>prompt.length<=700));
  assert.ok(selected[0].startsWith('999:'));
});
