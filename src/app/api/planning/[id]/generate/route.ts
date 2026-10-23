import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api, readJson } from '@/server/http';
import { getFullState } from '@/server/google-store';
import { ApiError } from '@/server/config';
import { requestGeneration, resumeGenerationRequest } from '@/server/generation-request';
import type { Topic } from '@/lib/types';
import { currentApprovedProposal, generationInstructions } from '@/server/proposal-selection';

export const maxDuration = 300;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { return api(async () => {
  const { profile } = await requireProfile();
  const { id } = await context.params;
  z.string().uuid().parse(id);
  const input = await readJson(request, z.object({ requestId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), turnId: z.string().uuid(), proposalId: z.string().min(1).max(200), targetCount: z.number().int().min(1).max(300).optional(), title: z.string().trim().min(1).max(150).optional(),approveSamples:z.boolean().optional(),dailyQuestionTarget:z.number().int().min(1).max(100).optional(),plannedDays:z.number().int().min(1).max(300).optional() }));
  const { data } = await getFullState();
  const plan = data.plans.find(plan => plan.id === id && plan.ownerId === profile.id);
  if (!plan) throw new ApiError(404, '自分の学習相談が見つかりません。');
  const previous = await resumeGenerationRequest(data,profile,{...input,planId:id});
  if (previous) return previous;
  const {turn,proposal}=currentApprovedProposal(data,profile,id,input);
  const topic: Topic = { id: randomUUID(), ownerId: profile.id, title: input.title || proposal.title, subject: proposal.subject, description: proposal.description,
    targetCount: input.targetCount ?? proposal.targetCount, createdAt: new Date().toISOString(), planId: id,
    audienceUserId: profile.role === 'student' || plan.testOnly ? profile.id : undefined,testOnly:plan.testOnly };
  return requestGeneration(profile, { topic, newTopic: true, sourceIds: proposal.sourceIds, targetCount: topic.targetCount,
    requestId: input.requestId, expectedVersion:input.expectedVersion, planId: id, turnId: turn!.id, proposalId: proposal.id,
    approveSamples:input.approveSamples,dailyQuestionTarget:input.dailyQuestionTarget,plannedDays:input.plannedDays,instructions: generationInstructions(plan,proposal) });
}, 202); }
