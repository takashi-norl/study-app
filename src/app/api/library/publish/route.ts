import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvents,getFullState } from '@/server/google-store';
import { prepareLibraryPublication } from '@/server/library';
import { ApiError } from '@/server/config';
export const maxDuration=300;

export async function POST(request:Request) {return api(async()=>{
  const {profile}=await requireProfile('parent');
  const {topicId}=await readJson(request,z.object({topicId:z.string().uuid()}).strict());
  const {data}=await getFullState();
  const prepared=prepareLibraryPublication(data,profile,topicId);
  const prior=data.topics.find(topic=>topic.id===prepared.topic.id && topic.libraryPublished);
  if(prior) return {topic:prior,publishedCount:prior.targetCount};
  // Staged question rows are invisible until the final manifest exists; each row has a stable id.
  for(const event of prepared.events) await appendEvents([event]);
  const canonical=(await getFullState()).data.topics.find(topic=>topic.id===prepared.topic.id && topic.libraryPublished);
  if(!canonical) throw new ApiError(503,'公開の保存を確認できませんでした。同じ操作で再試行してください。','LIBRARY_SAVE_FAILED');
  return {topic:canonical,publishedCount:canonical.targetCount};
},201);}
