import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationJob,LearningPlan,Profile,Question,Topic } from '../../src/lib/types';
import { foldEvents,studyDataForProfile,type StudyEvent } from '../../src/server/google-store';
import { getFamilyId } from '../../src/server/env';
import { assertPlanMode,learningSummary } from '../../src/server/planning';
import { materializeQuestions } from '../../src/server/generated-batch';
import { assertGenerationAccess } from '../../src/server/proposal-selection';
import { assertPracticeTopic,authorizedPracticeSession,mayPracticeQuestion,mayResumePracticeQuestions } from '../../src/server/practice-access';
import { assertOrdinaryPublication,assertQuestionEditable,prepareLibraryAdoption,prepareLibraryPublication } from '../../src/server/library';
import { authorizedAudioText } from '../../src/server/audio';
import { notificationQuestions } from '../../src/server/push';
import { canAccessSource } from '../../src/server/access';

const now='2026-10-23T00:00:00Z';
const parent:Profile={id:'parent',familyId:getFamilyId(),role:'parent',name:'Parent'};
const otherParent:Profile={...parent,id:'other-parent'};
const student:Profile={...parent,id:'student',role:'student',name:'Student'};
const profiles=[parent,otherParent,student];
const topic:Topic={id:'f82ca4c5-44b1-475c-bfa1-5e4746cfa2de',title:'英語の確認',subject:'英語',description:'基本語彙',createdAt:now,targetCount:10,testOnly:true,audienceUserId:parent.id,planId:'PRIVATE_PLAN'};
const plan:LearningPlan={id:'PRIVATE_PLAN',ownerId:parent.id,title:topic.title,subject:'英語',goal:'PRIVATE_PARENT_GOAL',difficulty:'高校1年',dailyQuestionTarget:10,sourceIds:['PRIVATE_SOURCE'],testOnly:true,version:1,createdAt:now,updatedAt:now};
const question:Question={id:'f3f917ee-1984-4679-972f-16b9541c8577',topicId:topic.id,prompt:'I read a book.',choices:['book','pen','desk','tree'],correctIndex:0,explanation:'book は本',learningPoint:'語彙',sourceIds:['PRIVATE_SOURCE'],sourceNote:'PRIVATE_SOURCE_NOTE',status:'published',needsReview:false,testOnly:true,audienceUserId:parent.id,planId:plan.id,version:1,createdAt:now,publishedAt:now};
const job:GenerationJob={id:'PRIVATE_JOB',topicId:topic.id,status:'review',targetCount:10,generatedCount:1,createdAt:now,planId:plan.id,requestedBy:parent.id,audienceUserId:parent.id,testOnly:true,sourceIds:[]};
const event=(id:string,type:StudyEvent['type'],payload:unknown):StudyEvent=>({id,type,actorId:parent.id,createdAt:now,payload});
function fixture() {
  const events=[event('plan','plan.created',plan),event('topic','topic.created',topic),event('q','question.upserted',question),event('job','job.upserted',job),
    event('source','source.created',{id:'PRIVATE_SOURCE',ownerId:student.id,testOnly:true,topicId:topic.id,name:'private.jpg',mimeType:'image/jpeg',storagePath:'PRIVATE_PATH',createdAt:now}),
    event('turn','planning.turn.upserted',{id:'PRIVATE_TURN',planId:plan.id,requestedBy:parent.id,version:2,status:'queued',message:'PRIVATE_PARENT_CHAT',createdAt:now})];
  return {events,data:foldEvents(events,profiles)};
}

test('test mode is parent-only, survives generation serialization and is invisible in every student collection',()=>{
  assert.doesNotThrow(()=>assertPlanMode(parent,true));
  assert.throws(()=>assertPlanMode(student,true),{code:'TEST_MODE_FORBIDDEN'});
  const {data}=fixture();
  assert.equal(assertGenerationAccess(data,job).id,parent.id);
  assert.throws(()=>assertGenerationAccess({...data,profiles:[{...parent,role:'student'}]},job),{code:'GENERATION_ACCESS_DENIED'});
  const generated=materializeQuestions([{...question,sourceIds:[]}],{job,sourceIds:[],prior:[],count:1,createdAt:now})[0];
  assert.equal(generated.testOnly,true);assert.equal(generated.status,'published');assert.equal(generated.needsReview,false);
  const projected=studyDataForProfile(data,student,new Date(now));
  for(const key of ['plans','topics','questions','sources','jobs','planningTurns'] as const) assert.equal(projected[key].length,0);
  assert.doesNotMatch(JSON.stringify(projected),/PRIVATE_/);
  assert.equal(canAccessSource(data.sources[0],student),false);
  assert.equal(studyDataForProfile(data,parent).questions.length,1);
  assert.throws(()=>assertOrdinaryPublication(question,topic),{code:'TEST_PUBLISH_FORBIDDEN'});
  assert.equal(notificationQuestions(data,student,[question.id],new Date(now)).length,0);
});

test('parents can practice only explicit test sets in their own sessions; tests never enter student practice, audio or growth',async()=>{
  const {data,events}=fixture();
  assert.doesNotThrow(()=>assertPracticeTopic(data,otherParent,topic.id));
  assert.throws(()=>assertPracticeTopic(data,parent),{code:'TEST_PRACTICE_ONLY'});
  assert.throws(()=>assertPracticeTopic(data,student,topic.id),{code:'TOPIC_NOT_FOUND'});
  assert.equal(mayPracticeQuestion(data,student,question),false);
  assert.equal(mayResumePracticeQuestions(data,parent,[question]),true);
  assert.equal(mayResumePracticeQuestions({...data,questions:[{...question,version:2}]},parent,[question]),false);
  const sessionId='d516da24-f27d-4a40-b727-160a386a3074';
  const session=event('session','session.created',{id:sessionId,userId:parent.id,mode:'extra',questionIds:[question.id],questionSnapshots:[question],createdAt:now});
  const attempt=event('attempt','attempt.recorded',{id:'attempt',userId:parent.id,questionId:question.id,questionVersion:1,sessionId,selectedIndex:0,correct:true,answeredAt:now});
  const full=foldEvents([...events,session,attempt],profiles);
  assert.equal((await authorizedPracticeSession(full,[...events,session],parent,sessionId)).questions.length,1);
  for(const profile of [student,otherParent]) await assert.rejects(()=>authorizedPracticeSession(full,[...events,session],profile,sessionId),{code:'SESSION_ACCESS_DENIED'});
  await assert.rejects(()=>authorizedAudioText(full,[...events,session],student,{sessionId,questionId:question.id,part:'prompt'}),{code:'AUDIO_QUESTION_NOT_FOUND'});
  assert.equal(await authorizedAudioText(full,[...events,session],parent,{sessionId,questionId:question.id,part:'prompt'}),'I read a book.');
  assert.equal(learningSummary(full,parent,'英語',new Date(now))[0].first.answered,0);
  assert.equal(studyDataForProfile(full,student,new Date(now)).attempts.length,0);
});

test('explicit library publication is idempotent, atomic and sanitized; adoption unlocks only the public clone',async()=>{
  const {data,events}=fixture();
  const first=prepareLibraryPublication(data,parent,topic.id,new Date(now));
  const retry=prepareLibraryPublication(data,otherParent,topic.id,new Date('2026-10-24T00:00:00Z'));
  assert.equal(first.topic.id,retry.topic.id);
  assert.equal(first.events.at(-1)?.id,retry.events.at(-1)?.id);
  assert.throws(()=>prepareLibraryPublication(data,student,topic.id),{code:'LIBRARY_PUBLISH_FORBIDDEN'});
  const staged=foldEvents([...events,...first.events.slice(0,-1)],profiles);
  assert.equal(studyDataForProfile(staged,student).topics.length,0);
  const publicData=foldEvents([...events,...first.events,...retry.events],profiles);
  assert.equal(publicData.topics.length,2);assert.equal(publicData.questions.length,2);
  const before=studyDataForProfile(publicData,student,new Date('2026-10-25T00:00:00Z'));
  assert.equal(before.topics.length,1);assert.equal(before.topics[0].libraryPublished,true);assert.equal(before.topics[0].librarySourceTopicId,undefined);assert.equal(before.questions.length,0);
  assert.doesNotMatch(JSON.stringify(before),/PRIVATE_/);
  assert.throws(()=>assertPracticeTopic(publicData,student,first.topic.id),{code:'LIBRARY_NOT_ADOPTED'});
  assert.throws(()=>prepareLibraryAdoption(publicData,student,topic.id),{code:'LIBRARY_NOT_FOUND'});
  const added=prepareLibraryAdoption(publicData,student,first.topic.id,new Date(now));
  const adopted=foldEvents([...events,...first.events,added.event!,added.event!],profiles);
  const visible=studyDataForProfile(adopted,student,new Date(now));
  assert.equal(visible.plans.length,1);assert.equal(visible.questions.length,1);
  assert.equal(prepareLibraryAdoption(adopted,student,first.topic.id).event,undefined);
  const publicQuestion=adopted.questions.find(q=>q.topicId===first.topic.id)!;
  assert.throws(()=>assertQuestionEditable(first.topic),{code:'LIBRARY_READ_ONLY'});
  assert.throws(()=>assertOrdinaryPublication(publicQuestion,first.topic),{code:'LIBRARY_READ_ONLY'});
  assert.notEqual(publicQuestion.id,question.id);assert.deepEqual(publicQuestion.sourceIds,[]);assert.equal(publicQuestion.planId,undefined);assert.equal(publicQuestion.testOnly,undefined);assert.equal(publicQuestion.audienceUserId,undefined);
  assert.doesNotMatch(JSON.stringify(publicQuestion),/PRIVATE_/);
  assert.doesNotThrow(()=>assertPracticeTopic(adopted,student,first.topic.id));
  assert.equal(mayPracticeQuestion(adopted,student,publicQuestion),true);
  assert.equal(notificationQuestions(publicData,student,[publicQuestion.id],new Date(now)).length,0);
  assert.equal(notificationQuestions(adopted,student,[publicQuestion.id],new Date(now)).length,1);
  assert.equal(adopted.questions.find(q=>q.id===question.id)?.testOnly,true);
});

test('library publication cannot copy unfinished, unreviewed or another student private sets',()=>{
  const {data}=fixture();
  assert.throws(()=>prepareLibraryPublication({...data,jobs:[{...job,status:'running'}]},parent,topic.id),{code:'GENERATION_ACTIVE'});
  assert.throws(()=>prepareLibraryPublication({...data,questions:[{...question,status:'draft'}]},parent,topic.id),{code:'REVIEW_REQUIRED'});
  assert.throws(()=>prepareLibraryPublication({...data,plans:[{...plan,ownerId:student.id}]},parent,topic.id),{code:'LIBRARY_ADMIN_SET_ONLY'});
  assert.throws(()=>prepareLibraryPublication(data,{...parent,familyId:'other-family'},topic.id),{code:'LIBRARY_PUBLISH_FORBIDDEN'});
  const changed=prepareLibraryPublication({...data,questions:[{...question,version:2}]},parent,topic.id);
  assert.notEqual(changed.topic.id,prepareLibraryPublication(data,parent,topic.id).topic.id);
});
