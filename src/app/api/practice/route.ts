import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { hideQuestionAnswer,stateForProfile } from '@/server/data';
import { appendEvent,getFullState,getSessionSnapshot } from '@/server/google-store';
import { ApiError } from '@/server/config';
import { selectQuestions } from '@/lib/learning';
import type { PracticeSession } from '@/lib/types';
import { assertPracticeTopic,authorizedPracticeSession,mayPracticeQuestion,mayResumePracticeQuestions } from '@/server/practice-access';
export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile();
  const input=await readJson(request,z.object({mode:z.enum(['daily','extra','weak']),topicId:z.string().uuid().optional()}));
  const {data,events}=await getFullState();
  assertPracticeTopic(data,profile,input.topicId);
  const open=data.sessions.filter(s=>s.userId===profile.id && s.mode===input.mode && !s.completedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  for(const session of open) {
    const questions=await getSessionSnapshot(session.id,events);
    if(questions.length===session.questionIds.length && mayResumePracticeQuestions(data,profile,questions) && (!input.topicId || questions.every(q=>q.topicId===input.topicId))) return {session,questions:questions.map(hideQuestionAnswer)};
  }
  const safe=stateForProfile(data,profile);
  const available=safe.questions.filter(question=>question.status==='published' && !!question.publishedAt && Date.parse(question.publishedAt)<=Date.now() && mayPracticeQuestion(data,profile,question));
  const selected=selectQuestions(available,profile.role==='parent' ? [] : safe.attempts,safe.exposures,profile.id,profile.role==='parent' ? 'extra' : input.mode,new Date(),10,input.topicId);
  if(!selected.length) throw new ApiError(409,'今、出題できる問題はありません。学習相談から問題を作るか、別の問題集や次の復習日に取り組んでみましょう。','NO_QUESTIONS');
  const session:PracticeSession={id:randomUUID(),userId:profile.id,mode:input.mode,questionIds:selected.map(q=>q.id),createdAt:new Date().toISOString()};
  const questionSnapshots=selected.map(q=>data.questions.find(full=>full.id===q.id && full.version===q.version)!);
  const history=data.sessions.map(s=>s.id).sort();
  const slotId=`practice:${createHash('sha256').update(JSON.stringify([profile.id,input.mode,input.topicId || null,history])).digest('hex')}`;
  await appendEvent({id:slotId,type:'session.created',actorId:profile.id,createdAt:session.createdAt,payload:{...session,questionSnapshots}});
  const canonical=await getFullState();
  const winningId=canonical.events.find(e=>e.id===slotId)?.payload.id as string|undefined;
  const winningSession=canonical.data.sessions.find(s=>s.id===winningId && s.userId===profile.id);
  if(!winningSession) throw new ApiError(503,'学習セットの保存を確認できませんでした。もう一度お試しください。');
  const authorized=await authorizedPracticeSession(canonical.data,canonical.events,profile,winningSession.id);
  return {session:authorized.session,questions:authorized.questions.map(hideQuestionAnswer)};
},201); }
