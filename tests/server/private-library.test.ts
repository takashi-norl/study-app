import assert from 'node:assert/strict';
import test from 'node:test';
import type { Profile, StudyData, Question } from '../../src/lib/types';
import { foldEvents, studyDataForProfile, type StudyEvent } from '../../src/server/google-store';
import { getFamilyId } from '../../src/server/env';
import { canAccessSource, canAccessPlan, canAccessQuestion, assertOwnQuestion } from '../../src/server/access';
import { assertPracticeTopic, mayPracticeQuestion, authorizedPracticeSession } from '../../src/server/practice-access';
import { authorizedAudioText } from '../../src/server/audio';
import { preparePlanArrangement } from '../../src/server/plan-arrangement';
import { buildPlanningContext, learningSummary } from '../../src/server/planning';

const now='2026-10-23T00:00:00Z';
const people:Profile[]=[{id:'owner',name:'Owner',role:'student',familyId:getFamilyId()},
  {id:'parent',name:'Parent',role:'parent',familyId:getFamilyId()}, {id:'other-parent',name:'Other parent',role:'parent',familyId:getFamilyId()}];
const [owner,parent,otherParent]=people;
const q:Question={id:'q-owner',ownerId:owner.id,audienceUserId:owner.id,topicId:'topic-owner',prompt:'Read a book.',choices:['book','pen'],correctIndex:0,
  explanation:'PERSONAL_EXPLANATION',learningPoint:'PERSONAL_POINT',sourceIds:['source-owner'],sourceNote:'PERSONAL_SOURCE_NOTE',status:'published',version:1,createdAt:now};
function fixture() {
  const events:StudyEvent[]=people.flatMap(person=>{
    const id=person.id;
    const e=(suffix:string,type:StudyEvent['type'],payload:unknown):StudyEvent=>({id:`${id}:${suffix}`,type,actorId:id,createdAt:now,payload});
    const question={...q,id:`q-${id}`,topicId:`topic-${id}`,ownerId:id,audienceUserId:id,sourceIds:[`source-${id}`],explanation:`${id}_PRIVATE_EXPLANATION`};
    return [e('topic','topic.created',{id:`topic-${id}`,ownerId:id,title:`${id}_PRIVATE_TOPIC`,subject:'英語',description:'',targetCount:1,createdAt:now}),
      e('q','question.upserted',question),e('source','source.created',{id:`source-${id}`,ownerId:id,name:`${id}_PRIVATE_FILE`,mimeType:'image/jpeg',storagePath:`${id}_PRIVATE_PATH`,createdAt:now}),
      e('plan','plan.created',{id:`plan-${id}`,ownerId:id,title:`${id}_PRIVATE_PLAN`,subject:'英語',goal:'Study',difficulty:'標準',dailyQuestionTarget:10,sourceIds:[`source-${id}`],version:1,createdAt:now,updatedAt:now}),
      e('turn','planning.turn.upserted',{id:`turn-${id}`,requestedBy:id,planId:`plan-${id}`,message:`${id}_PRIVATE_MESSAGE`,version:2,status:'queued',createdAt:now}),
      e('job','job.upserted',{id:`job-${id}`,requestedBy:id,topicId:`topic-${id}`,status:'review',targetCount:1,generatedCount:1,createdAt:now}),
      e('session','session.created',{id:`session-${id}`,userId:id,mode:'daily',questionIds:[question.id],questionSnapshots:[question],createdAt:now}),
      e('attempt','attempt.recorded',{id:`attempt-${id}`,userId:id,sessionId:`session-${id}`,questionId:question.id,questionVersion:1,selectedIndex:0,correct:true,answeredAt:now}),
      e('exposure','exposure.recorded',{id:`exposure-${id}`,userId:id,sessionId:`session-${id}`,questionId:question.id,questionVersion:1,shownAt:now})];
  });
  return {events,data:foldEvents(events,people)};
}

test('all roles receive only their own full authoring data, records and profile',()=>{
  const {data}=fixture();
  for(const person of people) {
    const visible=studyDataForProfile(data,person);
    for(const key of ['topics','questions','sources','plans','planningTurns','jobs','sessions','attempts','exposures','profiles'] as const) assert.equal(visible[key].length,1,key);
    assert.equal(visible.questions[0].correctIndex,0);
    assert.match(visible.questions[0].explanation,/PRIVATE_EXPLANATION/);
    assert.equal('questionSnapshots' in visible.sessions[0],false);
    for(const foreign of people.filter(p=>p.id!==person.id)) assert.equal(JSON.stringify(visible).includes(`"${foreign.id}_PRIVATE`),false);
    const summary=learningSummary(data,person,'英語',new Date(now));
    assert.equal(summary.length,1);assert.equal(summary[0].learner,person.name);assert.equal(summary[0].first.answered,1);
  }
  assert.equal(canAccessSource({},parent),false);
  assert.equal(canAccessSource({ownerId:owner.id},parent),false);
  assert.equal(canAccessPlan(data.plans[0],parent),false);
  assert.equal(canAccessQuestion({ownerId:owner.id,audienceUserId:parent.id},parent),false,'owner marker wins over stale audience');
});

test('parents cannot read another owner question, audio, plan arrangement or frozen session',async()=>{
  const {data,events}=fixture();
  for(const actor of [parent,otherParent]) {
    assert.throws(()=>buildPlanningContext(data,events,data.plans[0],data.planningTurns[0],actor),{code:'PLAN_NOT_FOUND'});
    assert.throws(()=>assertOwnQuestion(data,actor,q.id),{code:'QUESTION_NOT_FOUND'});
    assert.throws(()=>assertPracticeTopic(data,actor,q.topicId),{code:'TOPIC_NOT_FOUND'});
    assert.equal(mayPracticeQuestion(data,actor,q),false);
    assert.throws(()=>preparePlanArrangement(data,actor,q.topicId,'new-id'),{code:'TOPIC_NOT_FOUND'});
    await assert.rejects(()=>authorizedPracticeSession(data,events,actor,'session-owner'),{code:'SESSION_ACCESS_DENIED'});
    for(const sessionId of [undefined,'session-owner']) await assert.rejects(()=>authorizedAudioText(data,events,actor,{questionId:q.id,sessionId,part:'prompt'}),{code:'AUDIO_QUESTION_NOT_FOUND'});
  }
  assert.equal(assertOwnQuestion(data,owner,q.id).id,q.id);
  assert.equal(await authorizedAudioText(data,events,owner,{questionId:q.id,part:'prompt'}),'Read a book.');
});

test('all legacy public clones are hidden and unusable even after adoption or source removal',async()=>{
  const {data,events}=fixture();
  for(const sourceIds of [[],['source-owner']]) {
    const topic={...data.topics[0],id:'public',ownerId:undefined,audienceUserId:undefined,libraryPublished:true,librarySourceTopicId:q.topicId};
    const question={...q,id:'public-question',topicId:'public',ownerId:undefined,audienceUserId:undefined,sourceIds};
    const publicData:StudyData={...data,topics:[...data.topics,topic],questions:[...data.questions,question],
      plans:[...data.plans,{...data.plans[0],id:'adopted',ownerId:parent.id,libraryTopicId:'public',sourceIds:[]}]};
    for(const person of people) {
      const visible=studyDataForProfile(publicData,person);
      assert.ok(visible.topics.every(t=>!t.libraryPublished));
      assert.ok(visible.questions.every(q=>q.id!=='public-question'));
      assert.ok(visible.plans.every(p=>!p.libraryTopicId));
      assert.equal(mayPracticeQuestion(publicData,person,question),false);
      assert.throws(()=>assertPracticeTopic(publicData,person,'public'),{code:'TOPIC_NOT_FOUND'});
      await assert.rejects(()=>authorizedAudioText(publicData,events,person,{questionId:question.id,part:'prompt'}),{code:'AUDIO_QUESTION_NOT_FOUND'});
    }
  }
});
