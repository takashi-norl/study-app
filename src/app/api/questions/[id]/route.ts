import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvent,getFullState } from '@/server/google-store';
import { ApiError } from '@/server/config';
import type { Question } from '@/lib/types';
import { assertQuestionEditable } from '@/server/library';
export async function PATCH(request:Request,context:{params:Promise<{id:string}>}) { return api(async()=>{
  const {profile}=await requireProfile('parent');
  const {id}=await context.params;
  z.string().uuid().parse(id);
  const input=await readJson(request,z.object({
    prompt:z.string().trim().min(1).max(6000).optional(),choices:z.array(z.string().trim().min(1).max(2000)).min(2).max(6).optional(),
    correctIndex:z.number().int().min(0).max(5).optional(),explanation:z.string().trim().min(1).max(6000).optional(),
    learningPoint:z.string().max(1000).optional(),sourceNote:z.string().max(3000).optional(),
    status:z.enum(['draft','approved','archived']).optional(),needsReview:z.boolean().optional(),
    expectedVersion:z.number().int().positive().optional(),
  }).refine(value=>Object.keys(value).length>0));
  const {data}=await getFullState();
  const old=data.questions.find(q=>q.id===id);
  if(!old) throw new ApiError(404,'問題が見つかりません。');
  assertQuestionEditable(data.topics.find(topic=>topic.id===old.topicId));
  if(input.expectedVersion!==undefined && input.expectedVersion!==old.version) throw new ApiError(409,'別の画面で更新されました。読み込み直して確認してください。','VERSION_CONFLICT');
  const choices=input.choices ?? old.choices;
  const correctIndex=input.correctIndex ?? old.correctIndex;
  if(correctIndex>=choices.length || new Set(choices).size!==choices.length) throw new ApiError(400,'正解の番号と選択肢を確認してください。');
  const status=old.testOnly && input.status!=='archived' ? 'published' : input.status ?? 'draft';
  const needsReview=old.testOnly ? false : input.needsReview ?? (status==='draft' ? true : old.needsReview);
  if(status==='approved' && needsReview) throw new ApiError(400,'原本・正解・解説を確認してから承認してください。','REVIEW_REQUIRED');
  const prompt=input.prompt ?? old.prompt;
  const normalize=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
  if(data.questions.some(q=>q.id!==id && q.topicId===old.topicId && normalize(q.prompt)===normalize(prompt))) throw new ApiError(409,'同じ問題文がこの問題集に登録されています。');
  const question:Question={...old,prompt,choices,correctIndex,explanation:input.explanation ?? old.explanation,learningPoint:input.learningPoint ?? old.learningPoint,sourceNote:input.sourceNote ?? old.sourceNote,status,needsReview,version:old.version+1,publishedAt:status==='published' ? new Date().toISOString() : undefined};
  const eventId=randomUUID();
  await appendEvent({id:eventId,type:'question.upserted',actorId:profile.id,createdAt:new Date().toISOString(),payload:question});
  const final=(await getFullState()).data.questions.find(q=>q.id===id);
  const same=final && (['version','status','prompt','correctIndex','explanation','learningPoint','sourceNote','needsReview','publishedAt'] as const).every(key=>final[key]===question[key]) && JSON.stringify(final.choices)===JSON.stringify(question.choices);
  if(!same) throw new ApiError(409,'別の画面で先に更新されました。読み込み直してください。','VERSION_CONFLICT');
  return {question:final};
}); }
