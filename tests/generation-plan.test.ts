import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSources,plannedBatchCount,countForBatch,promptBudget,questionOutputTokenBudget } from '../src/server/generation-plan';

test('20 long photos are grouped into bounded requests without losing source text or citation IDs',()=>{
  const sources=Array.from({length:20},(_,index)=>({id:`source-${index}`,name:`資料${index}`,text:'あ'.repeat(50000)}));
  const groups=groupSources(sources);
  assert.ok(groups.length>1);
  for(const group of groups) assert.ok(JSON.stringify(group).length<=75000);
  for(const source of sources) assert.equal(groups.flat().filter(s=>s.id===source.id).map(s=>s.text).join(''),source.text);
  assert.deepEqual(groupSources(sources),groups);
});

test('100-question allocation visits every source group and never asks for more than 10 at once',()=>{
  const groupCount=20;
  const batches=plannedBatchCount(100,groupCount);
  let remaining=100;
  const covered=new Set<number>();
  for(let batch=0;batch<batches;batch++) {
    const count=countForBatch(remaining,batch,batches);
    assert.ok(count>0 && count<=10);
    covered.add(batch%groupCount);
    remaining-=count;
  }
  assert.equal(remaining,0);
  assert.equal(covered.size,groupCount);
});

test('100 knowledge questions are divided into ten bounded calls instead of five long calls',()=>{
  const batches=plannedBatchCount(100,0);
  assert.equal(batches,10);
  let remaining=100;
  for(let batch=0;batch<batches;batch++) {
    const count=countForBatch(remaining,batch,batches);
    assert.equal(count,10);
    remaining-=count;
  }
  assert.equal(remaining,0);
});

test('smaller batches preserve odd totals and source coverage without increasing the requested question total',()=>{
  for(const target of [1,10,11,103,300]) for(const groups of [0,1,3,20]) {
    const batches=plannedBatchCount(target,groups);
    let remaining=target;
    const covered=new Set<number>();
    for(let batch=0;batch<batches;batch++) {
      const count=countForBatch(remaining,batch,batches);
      assert.ok(count>=1&&count<=10&&count<=remaining);
      if(groups)covered.add(batch%groups);
      remaining-=count;
    }
    assert.equal(remaining,0);
    assert.equal(covered.size,Math.min(groups,target));
  }
});

test('question output budget scales while retaining room for Japanese passages and rejecting oversized batches',()=>{
  assert.ok(questionOutputTokenBudget(1)>=6000);
  assert.ok(questionOutputTokenBudget(5)>questionOutputTokenBudget(1));
  assert.ok(questionOutputTokenBudget(10)>questionOutputTokenBudget(5));
  assert.ok(questionOutputTokenBudget(10)>=11000&&questionOutputTokenBudget(10)<=22000);
  for(const count of [0,11,20,1.5])assert.throws(()=>questionOutputTokenBudget(count),RangeError);
});

test('context budget stays bounded as a topic gains many questions',()=>{
  const prompts=Array.from({length:1000},(_,index)=>`${index}:`+'問'.repeat(2000));
  const selected=promptBudget(prompts);
  assert.ok(selected.join('').length<=20000);
  assert.ok(selected.every(prompt=>prompt.length<=700));
  assert.ok(selected[0].startsWith('999:'));
});
