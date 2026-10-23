import { requireProfile } from '@/server/auth';
import { api, readJson } from '@/server/http';
import { appendEvents, getFullState } from '@/server/google-store';
import { learnerDeliverySchema, prepareLearnerDelivery } from '@/server/learner-delivery';
import { ApiError } from '@/server/config';

export const maxDuration = 300;

export async function POST(request: Request) {
  return api(async () => {
    const { profile } = await requireProfile('parent');
    const input = await readJson(request, learnerDeliverySchema);
    const initial = await getFullState();
    const prepared = prepareLearnerDelivery(initial.data, initial.events, profile, input);
    if (!prepared.alreadyDelivered) {
      // The first stable event fixes the receipt for overlapping retries before later batches are saved.
      await appendEvents([prepared.questionEvents[0]]);
      const reserved = await getFullState();
      const resumed = prepareLearnerDelivery(reserved.data, reserved.events, profile, input);
      // Questions remain invisible to the learner until their private topic is committed.
      if (!resumed.alreadyDelivered) for (const event of resumed.questionEvents.slice(1)) await appendEvents([event]);
      const latest = await getFullState();
      const checked = prepareLearnerDelivery(latest.data, latest.events, profile, input);
      if (checked.sourceRevision !== prepared.sourceRevision) {
        throw new ApiError(409, '配布の準備中に問題集が変わりました。内容を確認してやり直してください。', 'DELIVERY_SOURCE_CHANGED');
      }
      if (!checked.alreadyDelivered) await appendEvents(checked.completionEvents);
    }
    const stored = await getFullState();
    const confirmed = prepareLearnerDelivery(stored.data, stored.events, profile, input);
    if (!confirmed.alreadyDelivered) throw new ApiError(503, '配布の保存を確認できませんでした。同じ操作で再試行してください。', 'DELIVERY_SAVE_FAILED');
    return { plan: confirmed.plan, topic: confirmed.topic, deliveredCount: confirmed.deliveredCount };
  }, 201);
}
