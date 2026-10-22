import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api, readJson } from '@/server/http';
import { getFullState } from '@/server/google-store';
import { ApiError } from '@/server/config';
import { requestGeneration } from '@/server/generation-request';

export const maxDuration = 300;
export async function POST(request: Request) { return api(async () => {
  const { profile } = await requireProfile('parent');
  const input = await readJson(request, z.object({ topicId: z.string().uuid(), sourceIds: z.array(z.string().uuid()).min(1).max(20), targetCount: z.number().int().min(1).max(300) }));
  const { data } = await getFullState();
  const topic = data.topics.find(topic => topic.id === input.topicId);
  if (!topic) throw new ApiError(404, '問題集が見つかりません。');
  return requestGeneration(profile, { topic, sourceIds: input.sourceIds, targetCount: input.targetCount });
}, 202); }
