import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import type { GenerationJob,LearningPlan,Profile,Question,Topic } from '../../src/lib/types';
import { foldEvents,studyDataForProfile,type StudyEvent } from '../../src/server/google-store';
import { getWorkspaceId } from '../../src/server/env';
import { assertPlanMode,learningSummary } from '../../src/server/planning';
import { materializeQuestions } from '../../src/server/generated-batch';
import { assertGenerationAccess } from '../../src/server/proposal-selection';
import { assertPracticeTopic,authorizedPracticeSession,mayPracticeQuestion,mayResumePracticeQuestions } from '../../src/server/practice-access';
import { assertOrdinaryPublication,assertQuestionEditable,prepareLibraryAdoption,prepareLibraryPublication,prepareLibraryPublicationRequest } from '../../src/server/library';
import { authorizedAudioText } from '../../src/server/audio';
import { notificationQuestions } from '../../src/server/push';
import { canAccessSource } from '../../src/server/access';

const now='2026-10-23T00:00:00Z';

const previousMembers = process.env.REGISTERED_ACCOUNTS_JSON;
beforeEach(() => { process.env.REGISTERED_ACCOUNTS_JSON = JSON.stringify([
  { id: 'operator', name: 'Operator', email: 'takashi.oikawa@gmail.com', },
  { id: 'another-operator', name: 'Member', email: 'member@example.com', },
  { id: 'student', name: 'Student', email: 'student@example.com', },
]); });
afterEach(() => { if (previousMembers === undefined) delete process.env.REGISTERED_ACCOUNTS_JSON; else process.env.REGISTERED_ACCOUNTS_JSON = previousMembers; });

const operator:Profile={id:'operator',workspaceId:getWorkspaceId(),accessLevel:'superuser',name:'Operator'};
const otherMember:Profile={...operator,id:'other-operator',accessLevel:'learner'};
const student:Profile={...operator,id:'student',accessLevel:'learner',name:'Student'};
const profiles=[operator,otherMember,student];
const topic:Topic={id:'f82ca4c5-44b1-475c-bfa1-5e4746cfa2de',title:'英語の確認',subject:'英語',description:'基本語彙',createdAt:now,targetCount:10,testOnly:true,audienceUserId:operator.id,planId:'PRIVATE_PLAN'};
const plan:LearningPlan={id:'PRIVATE_PLAN',ownerId:operator.id,title:topic.title,subject:'英語',goal:'PRIVATE_OPERATOR_GOAL',difficulty:'高校1年',dailyQuestionTarget:10,sourceIds:['PRIVATE_SOURCE'],testOnly:true,version:1,createdAt:now,updatedAt:now};
const question:Question={id:'f3f917ee-1984-4679-972f-16b9541c8577',topicId:topic.id,prompt:'I read a book.',choices:['book','pen','desk','tree'],correctIndex:0,explanation:'book は本',learningPoint:'語彙',sourceIds:['PRIVATE_SOURCE'],sourceNote:'PRIVATE_SOURCE_NOTE',status:'published',needsReview:false,testOnly:true,audienceUserId:operator.id,planId:plan.id,version:1,createdAt:now,publishedAt:now};
const job:GenerationJob={id:'PRIVATE_JOB',topicId:topic.id,status:'review',targetCount:10,generatedCount:1,createdAt:now,planId:plan.id,requestedBy:operator.id,audienceUserId:operator.id,testOnly:true,sourceIds:[]};
const event=(id:string,type:StudyEvent['type'],payload:unknown):StudyEvent=>({id,type,actorId:operator.id,createdAt:now,payload});
function fixture() {
  const events=[event('plan','plan.created',plan),event('topic','topic.created',topic),event('q','question.upserted',question),event('job','job.upserted',job),
    event('source','source.created',{id:'PRIVATE_SOURCE',ownerId:student.id,testOnly:true,topicId:topic.id,name:'private.jpg',mimeType:'image/jpeg',storagePath:'PRIVATE_PATH',createdAt:now}),
    event('turn','planning.turn.upserted',{id:'PRIVATE_TURN',planId:plan.id,requestedBy:operator.id,version:2,status:'queued',message:'PRIVATE_OPERATOR_CHAT',createdAt:now})];
  return {events,data:foldEvents(events,profiles)};
}

test('test mode is operator-only, survives generation serialization and is invisible in every student collection',()=>{
  assert.doesNotThrow(()=>assertPlanMode(operator,true));
  assert.throws(()=>assertPlanMode(student,true),{code:'TEST_MODE_FORBIDDEN'});
  assert.throws(()=>assertPlanMode({...otherMember,id:'another-operator',accessLevel:'superuser'},true),{code:'TEST_MODE_FORBIDDEN'});
  const {data}=fixture();
  assert.equal(assertGenerationAccess(data,job).id,operator.id);
  assert.throws(()=>assertGenerationAccess({...data,profiles:[{...operator,accessLevel:'learner'}]},job),{code:'GENERATION_ACCESS_DENIED'});
  const generated=materializeQuestions([{...question,sourceIds:[]}],{job,sourceIds:[],prior:[],count:1,createdAt:now})[0];
  assert.equal(generated.testOnly,true);assert.equal(generated.status,'published');assert.equal(generated.needsReview,false);
  const projected=studyDataForProfile(data,student,new Date(now));
  for(const key of ['plans','topics','questions','sources','jobs','planningTurns'] as const) assert.equal(projected[key].length,0);
  assert.doesNotMatch(JSON.stringify(projected),/PRIVATE_/);
  assert.equal(canAccessSource(data.sources[0],student),false);
  assert.equal(studyDataForProfile(data,operator).questions.length,1);
  assert.throws(()=>assertOrdinaryPublication(question,topic),{code:'SHARING_DISABLED'});
  assert.equal(notificationQuestions(data,student,[question.id],new Date(now)).length,0);
});

test('operators can rehearse test sets in their own sessions; tests never enter student practice, audio or growth',async()=>{
  const {data,events}=fixture();
  assert.throws(()=>assertPracticeTopic(data,otherMember,topic.id),{code:'TOPIC_NOT_FOUND'});
  assert.doesNotThrow(()=>assertPracticeTopic(data,operator));
  assert.throws(()=>assertPracticeTopic(data,student,topic.id),{code:'TOPIC_NOT_FOUND'});
  assert.equal(mayPracticeQuestion(data,student,question),false);
  assert.equal(mayResumePracticeQuestions(data,operator,[question]),true);
  assert.equal(mayResumePracticeQuestions({...data,questions:[{...question,version:2}]},operator,[question]),false);
  const sessionId='d516da24-f27d-4a40-b727-160a386a3074';
  const session=event('session','session.created',{id:sessionId,userId:operator.id,mode:'extra',questionIds:[question.id],questionSnapshots:[question],createdAt:now});
  const attempt=event('attempt','attempt.recorded',{id:'attempt',userId:operator.id,questionId:question.id,questionVersion:1,sessionId,selectedIndex:0,correct:true,answeredAt:now});
  const full=foldEvents([...events,session,attempt],profiles);
  assert.equal((await authorizedPracticeSession(full,[...events,session],operator,sessionId)).questions.length,1);
  for(const profile of [student,otherMember]) await assert.rejects(()=>authorizedPracticeSession(full,[...events,session],profile,sessionId),{code:'SESSION_ACCESS_DENIED'});
  await assert.rejects(()=>authorizedAudioText(full,[...events,session],student,{sessionId,questionId:question.id,part:'prompt'}),{code:'AUDIO_QUESTION_NOT_FOUND'});
  assert.equal(await authorizedAudioText(full,[...events,session],operator,{sessionId,questionId:question.id,part:'prompt'}),'I read a book.');
  assert.equal(learningSummary(full,operator,'英語',new Date(now))[0].first.answered,0);
  assert.equal(studyDataForProfile(full,student,new Date(now)).attempts.length,0);
});

test('even administrators cannot publish or adopt a private or test set',()=>{
  const {data}=fixture();
  for(const actor of [operator,otherMember,student]) {
    assert.throws(()=>prepareLibraryPublication(data,actor,topic.id),{code:'SHARING_DISABLED'});
    assert.throws(()=>prepareLibraryPublicationRequest(data,actor,topic.id),{code:'SHARING_DISABLED'});
    assert.throws(()=>prepareLibraryAdoption(data,actor,topic.id),{code:'SHARING_DISABLED'});
  }
});
