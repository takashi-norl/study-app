import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvents,getFullState,type StudyEvent } from '@/server/google-store';
import { ApiError } from '@/server/config';
import type { Attempt } from '@/lib/types';
import { authorizedPracticeSession } from '@/server/practice-access';
export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile();
  const input=await readJson(request,z.object({sessionId:z.string().uuid(),questionId:z.string().uuid(),selectedIndex:z.number().int().min(0).max(5),attemptId:z.string().uuid()}));
  const {data,events}=await getFullState();
  const {session,questions}=await authorizedPracticeSession(data,events,profile,input.sessionId);
  if(!session.questionIds.includes(input.questionId)) throw new ApiError(403,'この問題は現在の学習セットに含まれていません。');
  const question=questions.find(q=>q.id===input.questionId);
  if(!question || input.selectedIndex>=question.choices.length) throw new ApiError(400,'回答内容を確認してください。');
  const previous=data.attempts.find(a=>a.sessionId===session.id && a.questionId===question.id);
  const attempt:Attempt=previous ?? {id:input.attemptId,userId:profile.id,questionId:question.id,questionVersion:question.version,sessionId:session.id,selectedIndex:input.selectedIndex,correct:input.selectedIndex===question.correctIndex,answeredAt:new Date().toISOString()};
  if(!previous) {
    const writes:StudyEvent[]=[{id:`answer:${session.id}:${question.id}`,type:'attempt.recorded',actorId:profile.id,createdAt:attempt.answeredAt,payload:attempt}];
    if(!data.exposures.some(e=>e.sessionId===session.id && e.questionId===question.id)) writes.push({id:`exposure:${session.id}:${question.id}`,type:'exposure.recorded',actorId:profile.id,createdAt:attempt.answeredAt,payload:{id:randomUUID(),userId:profile.id,questionId:question.id,questionVersion:question.version,sessionId:session.id,shownAt:attempt.answeredAt}});
    await appendEvents(writes);
  }
  // Re-read canonical first row so racing requests report the same accepted answer.
  const canonical=(await getFullState()).data.attempts.find(a=>a.sessionId===session.id && a.questionId===question.id);
  if(!canonical) throw new ApiError(503,'回答の保存を確認できませんでした。再送してください。');
  return {attempt:canonical,feedback:{correctIndex:question.correctIndex,explanation:question.explanation}};
}); }
