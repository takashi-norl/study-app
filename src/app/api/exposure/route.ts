import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvent,getFullState,getSessionSnapshot } from '@/server/google-store';
import { ApiError } from '@/server/config';
import type { Exposure } from '@/lib/types';
export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile('student');
  const input=await readJson(request,z.object({sessionId:z.string().uuid(),questionId:z.string().uuid()}));
  const {data,events}=await getFullState();
  const session=data.sessions.find(s=>s.id===input.sessionId && s.userId===profile.id);
  if(!session || !session.questionIds.includes(input.questionId)) throw new ApiError(403,'この問題は現在の学習セットに含まれていません。');
  const previous=data.exposures.find(e=>e.sessionId===session.id && e.questionId===input.questionId);
  if(previous) return {exposure:previous};
  const question=(await getSessionSnapshot(session.id,events)).find(q=>q.id===input.questionId);
  if(!question) throw new ApiError(404,'問題が見つかりません。');
  const exposure:Exposure={id:randomUUID(),userId:profile.id,questionId:question.id,questionVersion:question.version,sessionId:session.id,shownAt:new Date().toISOString()};
  await appendEvent({id:`exposure:${session.id}:${question.id}`,type:'exposure.recorded',actorId:profile.id,createdAt:exposure.shownAt,payload:exposure});
  return {exposure};
}); }
