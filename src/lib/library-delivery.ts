import type { LearningPlan, Topic } from './types';
import { normalizePlanTags } from './plan-organization';

export interface LibraryDeliveryInput {
  topicId: string; learnerId: string; requestId: string; projectName?: string;
}
export interface LibraryDeliveryResult {
  plan: LearningPlan; topic: Topic; deliveredCount: number;
}

/** A lost response reuses the same request; only a confirmed delivery releases it. */
export async function requestLibraryDelivery<T extends LibraryDeliveryResult>(requests: Map<string, string>, actorId: string,
  input: { topicId: string; learnerId: string; projectName: string },
  send: (body: LibraryDeliveryInput, signal: AbortSignal) => Promise<T>, createId = () => crypto.randomUUID()): Promise<T> {
  const projectName = input.projectName.trim();
  normalizePlanTags(projectName ? [projectName] : []);
  const key = `delivery:${JSON.stringify([actorId, input.topicId, input.learnerId, projectName])}`;
  const requestId = requests.get(key) ?? createId();
  requests.set(key, requestId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const result = await send({ topicId: input.topicId, learnerId: input.learnerId, requestId, ...(projectName ? { projectName } : {}) }, controller.signal);
    if (!result?.plan?.id || result.plan.ownerId !== input.learnerId || !result.topic?.id || result.topic.planId !== result.plan.id
      || result.topic.ownerId !== input.learnerId || !Number.isInteger(result.deliveredCount) || result.deliveredCount < 1) {
      throw new Error('保存の確認ができませんでした。同じ内容でもう一度確認できます。');
    }
    requests.delete(key);
    return result;
  } catch (error) {
    if (controller.signal.aborted || error instanceof TypeError) {
      throw new Error('学習者への追加を確認できませんでした。接続を確認して、同じ内容でもう一度お試しください。重ねて追加されないよう同じ依頼で確認します。');
    }
    throw error;
  } finally { clearTimeout(timeout); }
}
