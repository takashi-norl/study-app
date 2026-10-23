import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson,sameOriginForRequest } from '@/server/http';
import { createSourceUpload,getFullState } from '@/server/google-store';
import { ApiError,MAX_SOURCE_BYTES,SOURCE_MIME_TYPES } from '@/server/config';
import type { SourceDocument } from '@/lib/types';
import { canAccessQuestion } from '@/server/access';
export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile();
  const input=await readJson(request,z.object({topicId:z.string().uuid().optional(),name:z.string().min(1).max(200),mimeType:z.enum(SOURCE_MIME_TYPES),size:z.number().int().positive().max(MAX_SOURCE_BYTES)}));
  const {data}=await getFullState();
  const topic=data.topics.find(t=>t.id===input.topicId);
  if(input.topicId && (!topic || !canAccessQuestion(topic,profile))) throw new ApiError(404,'問題集が見つかりません。');
  const id=randomUUID();
  const result=await createSourceUpload({sourceId:id,ownerId:profile.id,...input},sameOriginForRequest(request));
  const source:SourceDocument={id,topicId:input.topicId,ownerId:profile.id,name:input.name,mimeType:input.mimeType,storagePath:result.fileId,createdAt:new Date().toISOString(),testOnly:topic?.testOnly};
  // This metadata is provisional. Only /complete adds a source to the study event log.
  return {source,signedUrl:result.uploadUrl,token:'',path:result.fileId};
},201); }
