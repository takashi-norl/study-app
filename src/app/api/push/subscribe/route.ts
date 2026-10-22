import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvent } from '@/server/google-store';
import { ApiError } from '@/server/config';
import { pushConfigured,validatePushEndpoint } from '@/server/push';
export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile('student');
  const input=await readJson(request,z.object({subscription:z.object({endpoint:z.string().url().max(3000),keys:z.object({auth:z.string().regex(/^[A-Za-z0-9_-]{20,30}$/),p256dh:z.string().regex(/^[A-Za-z0-9_-]{80,100}$/)})}).nullable()}));
  if(input.subscription) {
    if(!pushConfigured()) throw new ApiError(503,'通知の設定がまだ完了していません。','PUSH_NOT_CONFIGURED');
    validatePushEndpoint(input.subscription.endpoint);
  }
  await appendEvent({id:randomUUID(),type:'push.subscribed',actorId:profile.id,createdAt:new Date().toISOString(),payload:{userId:profile.id,subscription:input.subscription}});
  return {ok:true};
}); }
