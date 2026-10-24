import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LearningPlan, Profile, StudyData } from '@/lib/types';
import type { StudyEvent } from './google-store';
import { ApiError } from './config';
import { getWorkspaceId } from './env';

export const planTagsSchema = z.array(z.string().trim().min(1).max(40)).max(64)
  .transform(tags => [...new Set(tags)])
  .refine(tags => tags.length <= 8, 'タグは8個まで設定できます。');
export const planTagsUpdateSchema = z.object({ tags: planTagsSchema }).strict();

/** Tags organize plans without changing the version used to approve AI proposals. */
export function preparePlanTagsUpdate(data: StudyData, profile: Profile, planId: string, tags: unknown,
  now = new Date(), createId: () => string = () => randomUUID()): { plan: LearningPlan; event?: StudyEvent } {
  const member = data.profiles.find(item => item.id === profile.id && item.workspaceId === getWorkspaceId());
  if (profile.workspaceId !== getWorkspaceId() || !member) {
    throw new ApiError(403, 'この学習プランのタグを変更する権限がありません。', 'PLAN_TAGS_FORBIDDEN');
  }
  const plan = data.plans.find(item => item.id === planId);
  if (!plan) throw new ApiError(404, '学習プランが見つかりません。', 'PLAN_NOT_FOUND');
  if (plan.ownerId !== member.id || (plan.testOnly && member.accessLevel !== 'superuser')) {
    throw new ApiError(403, 'タグは、この学習プランを作った本人が変更してください。', 'PLAN_TAGS_FORBIDDEN');
  }
  const normalized = planTagsSchema.parse(tags);
  if (JSON.stringify(plan.tags ?? []) === JSON.stringify(normalized)) return { plan: structuredClone(plan) };
  const updated = { ...plan, tags: normalized, updatedAt: now.toISOString() };
  return {
    plan: structuredClone(updated),
    // Old deployments recognize plan.updated, parse the full plan, and ignore its unchanged version.
    event: { id: `plan-tags:${createId()}`, type: 'plan.updated', actorId: member.id,
      createdAt: updated.updatedAt, payload: { ...updated, tagsOnly: true } },
  };
}
