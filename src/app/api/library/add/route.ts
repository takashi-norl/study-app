import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvent,getFullState } from '@/server/google-store';
import { prepareLibraryAdoption } from '@/server/library';
import { ApiError } from '@/server/config';

export async function POST(request:Request) {return api(async()=>{
  const {profile}=await requireProfile();
  const {topicId}=await readJson(request,z.object({topicId:z.string().uuid()}).strict());
  const {data}=await getFullState();
  const prepared=prepareLibraryAdoption(data,profile,topicId);
  if(!prepared.event) return {plan:prepared.plan};
  await appendEvent(prepared.event);
  const plan=(await getFullState()).data.plans.find(plan=>plan.ownerId===profile.id && plan.libraryTopicId===topicId && !plan.testOnly);
  if(!plan) throw new ApiError(503,'追加の保存を確認できませんでした。もう一度お試しください。','LIBRARY_SAVE_FAILED');
  return {plan};
},201);}
