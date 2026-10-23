import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
import { questionSetBundleSchema } from '../../src/lib/question-set-import';
import { prepareQuestionSetImport } from '../../src/server/question-set-import';
import { foldEvents, studyDataForProfile, type StudyEvent } from '../../src/server/google-store';
import { getFamilyId } from '../../src/server/env';
import type { Profile } from '../../src/lib/types';


const previousMembers = process.env.ALLOWED_FAMILY_MEMBERS_JSON;
beforeEach(() => { process.env.ALLOWED_FAMILY_MEMBERS_JSON = JSON.stringify([
  { id: 'parent', name: 'Operator', email: 'takashi.oikawa@gmail.com', role: 'parent' },
  { id: 'another-parent', name: 'Member', email: 'member@example.com', role: 'parent' },
  { id: 'student', name: 'Student', email: 'student@example.com', role: 'student' },
]); });
afterEach(() => { if (previousMembers === undefined) delete process.env.ALLOWED_FAMILY_MEMBERS_JSON; else process.env.ALLOWED_FAMILY_MEMBERS_JSON = previousMembers; });

const parent:Profile={id:'parent',name:'運営者',role:'parent',accessLevel:'superuser',familyId:getFamilyId()};
const learner:Profile={...parent,id:'learner',name:'生徒',role:'student',accessLevel:'learner'};
const time='2026-10-23T00:00:00.000Z';
const sourceId='1f226c88-3d32-4ff2-a833-777777777777';
const planId='1f226c88-3d32-4ff2-a833-666666666666';
function fixture(){
  const events:StudyEvent[]=[{id:'source',type:'source.created',actorId:parent.id,createdAt:time,payload:{id:sourceId,name:'教材',ownerId:parent.id,mimeType:'application/pdf',createdAt:time}},
    {id:'plan',type:'plan.created',actorId:parent.id,createdAt:time,payload:{id:planId,ownerId:parent.id,title:'テスト',subject:'古文',goal:'単語を覚える',difficulty:'基礎',dailyQuestionTarget:10,sourceIds:[sourceId],version:1,createdAt:time,updatedAt:time}}];
  const bundle={version:1 as const,bundleId:'1f226c88-3d32-4ff2-a833-555555555555',title:'古文単語',subject:'古文',description:'意味を確認',planId,
    questions:[{prompt:'「まもる」の意味を選ぶ。',choices:['見つめる','食べる','眠る','帰る'],correctIndex:0,explanation:'この語義は見つめる。',learningPoint:'まもる',sourceIds:[sourceId],sourceNote:'教材No.59'}]};
  return {events,data:foldEvents(events,[parent,learner]),input:{bundle,reviewed:true}};
}
test('reviewed import creates a private approved set and no paid generation or learner record',()=>{
  const {data,events,input}=fixture();
  const saved=prepareQuestionSetImport(data,events,parent,input,new Date(time));
  const after=foldEvents([...events,...saved.events],[parent,learner]);
  assert.equal(after.questions.length,1);assert.equal(after.questions[0].status,'approved');assert.equal(after.questions[0].needsReview,false);
  assert.equal(after.topics[0].planId,planId);assert.equal(after.topics[0].ownerId,parent.id);
  assert.equal(studyDataForProfile(after,learner).questions.length,0);
  assert.equal(after.jobs.length,0);assert.equal(after.attempts.length,0);
});
test('same file retry is idempotent and never overwrites subsequent edits',()=>{
  const {data,events,input}=fixture();const p=prepareQuestionSetImport(data,events,parent,input,new Date(time));
  const edit:StudyEvent={id:'edit',type:'question.upserted',actorId:parent.id,createdAt:time,payload:{...p.questions[0],version:2,explanation:'改善した解説'}};
  const all=[...events,...p.events,edit];const after=foldEvents(all,[parent]);
  const again=prepareQuestionSetImport(after,all,parent,input);
  assert.equal(again.alreadyImported,true);assert.deepEqual(again.events,[]);assert.equal(after.questions[0].explanation,'改善した解説');
});
test('an interrupted import resumes only the topic commit',()=>{
  const {data,events,input}=fixture();const p=prepareQuestionSetImport(data,events,parent,input,new Date(time));
  const all=[...events,p.events[0]];const again=prepareQuestionSetImport(foldEvents(all,[parent]),all,parent,input);
  assert.equal(again.events.length,1);assert.equal(again.events[0].type,'topic.created');assert.equal(again.topic.createdAt,time);
});
test('non-admin, other family, and unconfirmed import are rejected',()=>{
  const {data,events,input}=fixture();
  assert.throws(()=>prepareQuestionSetImport(data,events,learner,input));
  assert.throws(()=>prepareQuestionSetImport(data,events,{...parent,familyId:'other'},input));
  assert.throws(()=>prepareQuestionSetImport(data,events,parent,{...input,reviewed:false}));
});
test('source, plan ownership and subject are checked before any writes',()=>{
  const {data,events,input}=fixture();
  assert.throws(()=>prepareQuestionSetImport({...data,sources:[]},events,parent,input));
  assert.throws(()=>prepareQuestionSetImport({...data,plans:data.plans.map(p=>({...p,ownerId:learner.id}))},events,parent,input));
  assert.throws(()=>prepareQuestionSetImport(data,events,parent,{...input,bundle:{...input.bundle,subject:'英語'}}));
});
test('malformed choices, forged owner and duplicate prompts are rejected',()=>{
  const {input}=fixture();const q=input.bundle.questions[0];
  assert.equal(questionSetBundleSchema.safeParse({...input.bundle,ownerId:learner.id}).success,false);
  assert.equal(questionSetBundleSchema.safeParse({...input.bundle,questions:[{...q,choices:['見つめる','見つめる','眠る','帰る']}]}).success,false);
  assert.equal(questionSetBundleSchema.safeParse({...input.bundle,questions:[q,{...q,prompt:` ${q.prompt} `}]}).success,false);
});
test('legacy parent roles and forged operator claims cannot import and template stays classical-only',()=>{
  const {data,events,input}=fixture();const unlinked={...input,bundle:{...input.bundle,planId:undefined,questions:input.bundle.questions.map(q=>({...q,sourceIds:[]}))}};
  const first=prepareQuestionSetImport(data,events,parent,unlinked);
  assert.ok(first.topic.id);
  for (const id of ['another-parent', 'unknown']) assert.throws(()=>prepareQuestionSetImport(data,events,{...parent,id,accessLevel:'superuser'},unlinked),{code:'FORBIDDEN'});
  assert.equal(questionSetBundleSchema.safeParse({...input.bundle,subject:'英語',questionTemplate:'kobun-vocabulary'}).success,false);
});


test('a vocabulary-marked import must satisfy the same structural rules and retains its public mode label',()=>{
  const {data,events,input}=fixture();
  const bundle={...input.bundle,questionTemplate:'kobun-vocabulary' as const};
  assert.throws(()=>prepareQuestionSetImport(data,events,parent,{...input,bundle}),{code:'INVALID_VOCABULARY_QUESTION'});
  bundle.questions=bundle.questions.map(q=>({...q,prompt:`【意味】${q.prompt}`,learningPoint:'古文単語｜まもる'}));
  const saved=prepareQuestionSetImport(data,events,parent,{...input,bundle});
  const after=foldEvents([...events,...saved.events],[parent,learner]);
  assert.equal(after.topics[0].questionTemplate,'kobun-vocabulary');
  assert.equal(after.plans[0].questionTemplate,undefined,'an existing plan is not silently reclassified');
  assert.equal(after.questions[0].learningPoint,'古文単語｜まもる');
  assert.throws(()=>prepareQuestionSetImport(data,events,parent,{...input,bundle:{...bundle,questions:bundle.questions.map(q=>({...q,explanation:'正解はAです。'}))}}),{code:'INVALID_VOCABULARY_QUESTION'});
});
