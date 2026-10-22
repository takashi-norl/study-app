import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvent,getDriveFileMetadata,getFullState } from '@/server/google-store';
import { getDriveConfig } from '@/server/env';
import { ApiError } from '@/server/config';
import { assertCompletedSourceMetadata } from '@/server/source-validation';
import { canAccessSource,canAccessQuestion } from '@/server/access';
import type { SourceDocument } from '@/lib/types';

export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile();
  const input=await readJson(request,z.object({sourceId:z.string().uuid(),topicId:z.string().uuid().optional(),storagePath:z.string().regex(/^[a-zA-Z0-9_-]{8,200}$/)}));
  const {data}=await getFullState();
  const topic=data.topics.find(t=>t.id===input.topicId);
  if(input.topicId && (!topic || !canAccessQuestion(topic,profile) || (profile.role!=='parent' && topic.audienceUserId!==profile.id))) throw new ApiError(404,'問題集が見つかりません。');
  const existing=data.sources.find(source=>source.id===input.sourceId);
  if(existing) {
    if(!canAccessSource(existing,profile)) throw new ApiError(403,'この資料にはアクセスできません。');
    if(existing.topicId!==input.topicId || existing.storagePath!==input.storagePath) throw new ApiError(409,'この資料は別のアップロードとして登録されています。');
    return {source:existing};
  }
  const metadata=await getDriveFileMetadata(input.storagePath);
  const ownerId=metadata.appProperties?.ownerId;
  if(!canAccessSource({ownerId},profile)) throw new ApiError(403,'この資料にはアクセスできません。');
  assertCompletedSourceMetadata(metadata,{...input,ownerId,folderId:getDriveConfig().folderId});
  const source:SourceDocument={id:input.sourceId,topicId:input.topicId,ownerId,name:metadata.name,mimeType:metadata.mimeType,storagePath:metadata.id,createdAt:new Date().toISOString(),testOnly:topic?.testOnly};
  await appendEvent({id:`source:${source.id}`,type:'source.created',actorId:profile.id,createdAt:source.createdAt,payload:source});
  return {source};
},201); }
