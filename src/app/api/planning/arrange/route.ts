import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvent,getFullState } from '@/server/google-store';
import { preparePlanArrangement } from '@/server/plan-arrangement';
import { ApiError } from '@/server/config';

export async function POST(request:Request) {return api(async()=>{
  const {profile}=await requireProfile();
  const input=await readJson(request,z.object({topicId:z.string().uuid(),requestId:z.string().uuid()}).strict());
  const prepared=preparePlanArrangement((await getFullState()).data,profile,input.topicId,input.requestId);
  if(!prepared.event) return {plan:prepared.plan};
  await appendEvent(prepared.event);
  const plan=(await getFullState()).data.plans.find(plan=>plan.id===input.requestId);
  if(!plan || plan.ownerId!==profile.id || plan.arrangedFromTopicId!==input.topicId) throw new ApiError(409,'相談の保存を確認できませんでした。同じ操作で再試行してください。','REQUEST_CONFLICT');
  return {plan};
},201);}
