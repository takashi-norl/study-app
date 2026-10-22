import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvent,getFullState } from '@/server/google-store';
import { prepareLibraryPublicationRequest } from '@/server/library';
import { ApiError } from '@/server/config';

export async function POST(request:Request) {return api(async()=>{
  const {profile}=await requireProfile();
  const {topicId}=await readJson(request,z.object({topicId:z.string().uuid()}).strict());
  const prepared=prepareLibraryPublicationRequest((await getFullState()).data,profile,topicId);
  if(!prepared.event) return {topic:prepared.topic,request:prepared.request};
  await appendEvent(prepared.event);
  const topic=(await getFullState()).data.topics.find(item=>item.id===topicId);
  if(topic?.publicationRequest?.revision!==prepared.request.revision) throw new ApiError(503,'公開依頼の保存を確認できませんでした。同じ操作で再試行してください。','LIBRARY_SAVE_FAILED');
  return {topic,request:topic.publicationRequest};
},201);}
