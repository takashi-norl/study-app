import { randomUUID } from 'node:crypto';
import { requireProfile } from '@/server/auth';
import { api, readJson } from '@/server/http';
import { appendEvent, getFullState } from '@/server/google-store';
import { assertPlanMode, createPlanSchema, validatePlanningSources } from '@/server/planning';
import { ApiError } from '@/server/config';
import type { LearningPlan } from '@/lib/types';

export async function POST(request:Request) {return api(async()=>{
  const {profile}=await requireProfile();
  const input=await readJson(request,createPlanSchema);
  assertPlanMode(profile,input.testOnly);
  const {data}=await getFullState();
  validatePlanningSources(data,profile,input.sourceIds);
  if(data.plans.filter(plan=>plan.ownerId===profile.id).length>=100) throw new ApiError(429,'学習プランは1人100件までです。既存のプランで相談を続けてください。','PLAN_LIMIT');
  const now=new Date().toISOString();
  const plan:LearningPlan={...input,sampleFirst:true,id:randomUUID(),ownerId:profile.id,title:input.title || input.goal.slice(0,80),version:1,createdAt:now,updatedAt:now};
  await appendEvent({id:`plan:${plan.id}`,type:'plan.created',actorId:profile.id,createdAt:now,payload:plan});
  return {plan};
},201);}
