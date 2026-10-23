import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { appendEvent } from '@/server/google-store';
import type { Topic } from '@/lib/types';
export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile();
  const input=await readJson(request,z.object({title:z.string().trim().min(1).max(150),subject:z.string().trim().min(1).max(40),description:z.string().max(3000).default(''),targetCount:z.number().int().min(1).max(300).default(100)}));
  const topic:Topic={id:randomUUID(),ownerId:profile.id,...input,createdAt:new Date().toISOString()};
  await appendEvent({id:`topic:${topic.id}`,type:'topic.created',actorId:profile.id,createdAt:topic.createdAt,payload:topic});
  return {topic};
},201); }
