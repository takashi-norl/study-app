import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson,sameOriginForRequest } from '@/server/http';
import { createSourceUpload,getFullState } from '@/server/google-store';
import { ApiError,MAX_SOURCE_BYTES,SOURCE_MIME_TYPES } from '@/server/config';
import type { SourceDocument } from '@/lib/types';
export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile('parent');
  const input=await readJson(request,z.object({topicId:z.string().uuid(),name:z.string().min(1).max(200),mimeType:z.enum(SOURCE_MIME_TYPES),size:z.number().int().positive().max(MAX_SOURCE_BYTES)}));
  const {data}=await getFullState();
  if(!data.topics.some(t=>t.id===input.topicId)) throw new ApiError(404,'問題集が見つかりません。');
  const id=randomUUID();
  const result=await createSourceUpload({sourceId:id,...input},sameOriginForRequest(request));
  const source:SourceDocument={id,topicId:input.topicId,name:input.name,mimeType:input.mimeType,storagePath:result.fileId,createdAt:new Date().toISOString()};
  // This metadata is provisional. Only /complete adds a source to the study event log.
  return {source,signedUrl:result.uploadUrl,token:'',path:result.fileId};
},201); }
