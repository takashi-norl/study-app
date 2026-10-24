import assert from 'node:assert/strict';
import test from 'node:test';
import {createDemoData} from '../src/lib/demo-data';
import {addDemoPlanningTurn,arrangeDemoTopic,generateDemoProposal} from '../src/lib/demo-access';
import type {LearningPlan} from '../src/lib/types';

const now='2026-10-23T00:00:00.000Z';
function setup(){
  const data=createDemoData(new Date(now));const user=data.profiles[0];let number=0;const id=()=>`sample-${++number}`;
  const plan:LearningPlan={id:'sample-plan',ownerId:user.id,title:'英語の練習',subject:'英語',goal:'語彙を練習',difficulty:'標準',dailyQuestionTarget:10,sourceIds:[],sampleFirst:true,version:1,createdAt:now,updatedAt:now};
  return {data:{...data,plans:[...data.plans,plan]},user,plan,id};
}
test('initial discussion provides exactly three preview questions without creating a practice bank',()=>{
  const {data,user,plan,id}=setup();const updated=addDemoPlanningTurn(data,user,plan.id,'まず3問',now,id);const turn=updated.planningTurns.at(-1)!;
  assert.equal(turn.samplePreview,true);assert.equal(turn.proposals?.[0].samples?.length,3);
  assert.equal(updated.questions.length,data.questions.length);assert.equal(updated.topics.length,data.topics.length);assert.equal(updated.jobs.length,data.jobs.length);
  for(const question of turn.proposals![0].samples!){assert.equal(question.choices.length,4);assert.ok(question.correctIndex>=0);assert.ok(question.explanation);}
});
test('bulk generation requires current previews and approval; daily volume is persisted independently from the preview',()=>{
  const {data,user,plan,id}=setup();const updated=addDemoPlanningTurn(data,user,plan.id,'まず3問',now,id);const turn=updated.planningTurns.at(-1)!;const proposal=turn.proposals![0];
  assert.throws(()=>generateDemoProposal(updated,user,plan.id,turn.id,proposal.id,70,now,id),/試作3問/);
  const revised=addDemoPlanningTurn(updated,user,plan.id,'穴埋め中心',now,id);
  assert.throws(()=>generateDemoProposal(revised,user,plan.id,turn.id,proposal.id,70,now,id,{approveSamples:true}),/最新/);
  const result=generateDemoProposal(updated,user,plan.id,turn.id,proposal.id,70,now,id,{approveSamples:true,dailyQuestionTarget:10,plannedDays:7});
  assert.equal(result.topic.targetCount,70);assert.equal(result.data.questions.filter(q=>q.topicId===result.topic.id).length,70);
  assert.equal(result.data.jobs.at(-1)?.approvedSamples?.length,3);assert.equal(result.data.plans.find(p=>p.id===plan.id)?.plannedDays,7);
});
test('arranging an existing collection creates a separate private plan and leaves originals unchanged',()=>{
  const {data,user,id}=setup();const topic=data.topics.find(t=>t.subject==='英語')!;const originalQuestions=structuredClone(data.questions);
  const {data:arranged,plan}=arrangeDemoTopic(data,user,topic.id,now,id);
  assert.equal(plan.ownerId,user.id);assert.equal(plan.arrangedFromTopicId,topic.id);assert.equal(plan.sampleFirst,true);assert.equal(plan.requestedQuestionCount,undefined);
  assert.equal(arranged.questions.length,data.questions.length);assert.deepEqual(arranged.questions.map(q=>q.prompt),originalQuestions.map(q=>q.prompt));assert.equal(arranged.planningTurns.length,data.planningTurns.length);
});
