import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { ApiError } from '@/server/config';
import { appendEvent, getFullState } from '@/server/google-store';
import { api, readJson } from '@/server/http';
import { planTagsUpdateSchema, preparePlanTagsUpdate } from '@/server/plan-tags';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { profile } = await requireProfile();
    const id = z.string().uuid().parse((await context.params).id);
    const input = await readJson(request, planTagsUpdateSchema);
    const { data } = await getFullState();
    const prepared = preparePlanTagsUpdate(data, profile, id, input.tags);
    if (!prepared.event) return { plan: prepared.plan };
    await appendEvent(prepared.event);
    const stored = (await getFullState()).data.plans.find(plan => plan.id === id && plan.ownerId === profile.id);
    if (!stored || JSON.stringify(stored.tags ?? []) !== JSON.stringify(prepared.plan.tags ?? [])) {
      throw new ApiError(409, 'タグが別の画面で更新されました。最新の内容を確認してください。', 'PLAN_TAGS_CONFLICT');
    }
    return { plan: stored };
  });
}
