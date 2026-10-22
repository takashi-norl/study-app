import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { start } from 'workflow/api';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvents,getFullState,type StudyEvent } from '@/server/google-store';
import { ApiError } from '@/server/config';
import { pushConfigured } from '@/server/push';
import { publicationNotificationWorkflow } from '@/workflows/notify';
import type { Question } from '@/lib/types';
import { assertOrdinaryPublication } from '@/server/library';
export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile('parent');
  const input=await readJson(request,z.object({questionIds:z.array(z.string().uuid()).min(1).max(300),publishedAt:z.string().datetime({offset:true}).optional()}));
  const ids=[...new Set(input.questionIds)];
  const {data}=await getFullState();
  const now=new Date();
  const publishedAt=input.publishedAt ? new Date(Math.max(now.getTime(),Date.parse(input.publishedAt))).toISOString() : now.toISOString();
  if(Date.parse(publishedAt)>now.getTime()+365*24*60*60*1000) throw new ApiError(400,'公開日は1年以内を指定してください。');
  const questions:Question[]=ids.map(id=>{
    const question=data.questions.find(q=>q.id===id);
    if(!question) throw new ApiError(404,'選択した問題が見つかりません。');
    assertOrdinaryPublication(question,data.topics.find(topic=>topic.id===question.topicId));
    if(question.status!=='approved' || question.needsReview) throw new ApiError(409,'原本・正解・解説を確認して承認した問題のみ公開できます。','REVIEW_REQUIRED');
    return {...question,status:'published',version:question.version+1,publishedAt};
  });
  const events:StudyEvent[]=[];
  const publishId=randomUUID();
  if(Buffer.byteLength(JSON.stringify(questions),'utf8')>1800000) throw new ApiError(413,'問題の本文が長いため、公開する問題を100問程度ずつ選んでください。');
  // Bound each row even after a parent has expanded the explanation or passage.
  let chunk:Question[]=[];
  const flush=()=>{if(chunk.length) events.push({id:`publish:${publishId}:${events.length}`,type:'questions.published',actorId:profile.id,createdAt:now.toISOString(),payload:{questions:chunk}});chunk=[];};
  for(const question of questions) {
    if(chunk.length && JSON.stringify([...chunk,question]).length>250000) flush();
    chunk.push(question);
  }
  flush();
  await appendEvents(events);
  const canonical=(await getFullState()).data.questions;
  const publishedCount=questions.filter(q=>canonical.some(c=>c.id===q.id && c.version===q.version && c.status==='published')).length;
  if(publishedCount!==questions.length) throw new ApiError(409,'一部の問題が別の画面で更新されました。最新の状態を確認してください。','VERSION_CONFLICT');
  let notification:'disabled'|'queued'|'unavailable'='disabled';
  if(pushConfigured()) {
    try { await start(publicationNotificationWorkflow,[ids,publishedAt]);notification='queued'; }
    catch { notification='unavailable'; }
  }
  return {publishedCount,publishedAt,notification};
}); }
