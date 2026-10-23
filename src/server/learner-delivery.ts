import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LearningPlan, Profile, Question, StudyData, Topic } from '@/lib/types';
import { topicOwnerId } from '@/lib/library-policy';
import type { StudyEvent } from './google-store';
import { getFamilyId } from './env';
import { planTagsSchema } from './plan-tags';
import { ApiError } from './config';

export const learnerDeliverySchema = z.object({
  topicId: z.string().uuid(), learnerId: z.string().min(1).max(100), requestId: z.string().uuid(),
  projectName: z.string().trim().min(1).max(40).optional(), tags: planTagsSchema.optional(),
}).strict();
export type LearnerDeliveryInput = z.infer<typeof learnerDeliverySchema>;

const receiptSchema = z.object({
  requestId: z.string().uuid(), actorId: z.string(), sourceTopicId: z.string().uuid(), learnerId: z.string(),
  tags: planTagsSchema, sourceRevision: z.string().length(64), createdAt: z.string().datetime(),
  planId: z.string().uuid(), topicId: z.string().uuid(), questionIds: z.array(z.string().uuid()).min(1).max(300),
});
type DeliveryReceipt = z.infer<typeof receiptSchema>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function stableId(value: unknown) {
  const digest = hash(value);
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
}

const copyableQuestion = z.object({
  prompt: z.string().trim().min(1).max(6000), choices: z.array(z.string().trim().min(1).max(2000)).min(2).max(10),
  correctIndex: z.number().int().min(0), explanation: z.string().trim().min(1).max(6000),
  learningPoint: z.string().max(1000),
}).refine(question => question.correctIndex < question.choices.length && new Set(question.choices).size === question.choices.length);

function conflict(message = '同じ依頼番号が別の操作に使われています。画面を更新して確認してください。'): never {
  throw new ApiError(409, message, 'DELIVERY_REQUEST_CONFLICT');
}

export interface PreparedLearnerDelivery {
  plan: LearningPlan;
  topic: Topic;
  deliveredCount: number;
  /** Staged questions have no visible topic until the final two events are saved. */
  questionEvents: StudyEvent[];
  completionEvents: StudyEvent[];
  sourceRevision: string;
  alreadyDelivered: boolean;
}

/** A private copy for one active family learner. Request receipts never enter projected StudyData. */
export function prepareLearnerDelivery(data: StudyData, events: StudyEvent[], actor: Profile,
  rawInput: LearnerDeliveryInput, now = new Date()): PreparedLearnerDelivery {
  const familyId = getFamilyId();
  const administrator = data.profiles.find(profile => profile.id === actor.id && profile.familyId === familyId && profile.role === 'parent');
  if (actor.role !== 'parent' || actor.familyId !== familyId || !administrator) {
    throw new ApiError(403, '学習者への配布は、現在登録されている管理者だけができます。', 'DELIVERY_FORBIDDEN');
  }
  const input = learnerDeliverySchema.parse(rawInput);
  const tags = planTagsSchema.parse([...(input.tags ?? []), ...(input.projectName ? [input.projectName] : [])]);
  const learner = data.profiles.find(profile => profile.id === input.learnerId && profile.familyId === familyId && profile.role === 'student');
  if (!learner) throw new ApiError(404, '届け先の学習者が現在の家族アカウントに見つかりません。', 'LEARNER_NOT_FOUND');
  const prefix = `learner-delivery:${input.requestId}:`;
  const recorded = events.filter(event => event.id.startsWith(prefix));
  let receipt: DeliveryReceipt | undefined;
  for (const event of recorded) {
    const parsed = receiptSchema.safeParse(event.payload?.delivery);
    if (!parsed.success || event.actorId !== administrator.id) conflict();
    const candidate = parsed.data;
    if (candidate.requestId !== input.requestId || candidate.actorId !== administrator.id
      || candidate.sourceTopicId !== input.topicId || candidate.learnerId !== learner.id
      || JSON.stringify(candidate.tags) !== JSON.stringify(tags)
      || receipt && JSON.stringify(receipt) !== JSON.stringify(candidate)) conflict();
    receipt = candidate;
  }

  const planId = input.requestId;
  const topicId = stableId(['learner-delivery-topic', input.requestId]);
  if (receipt && (receipt.planId !== planId || receipt.topicId !== topicId)) conflict();
  const existingPlan = data.plans.find(plan => plan.id === planId);
  const existingTopic = data.topics.find(topic => topic.id === topicId);
  if ((existingPlan || existingTopic) && !receipt) conflict();
  if (existingPlan && (existingPlan.ownerId !== learner.id || existingPlan.testOnly || existingPlan.libraryTopicId || existingPlan.sourceIds.length)) conflict();
  if (existingTopic && (existingTopic.ownerId !== learner.id || existingTopic.audienceUserId !== learner.id
    || existingTopic.planId !== planId || existingTopic.testOnly || existingTopic.libraryPublished)) conflict();
  if (existingPlan && existingTopic && receipt) {
    if (!receipt.questionIds.every(id => data.questions.some(question => question.id === id && question.topicId === topicId
      && question.ownerId === learner.id && question.audienceUserId === learner.id && question.planId === planId))) {
      throw new ApiError(409, '配布した問題の保存状態を確認できません。管理者に確認してください。', 'DELIVERY_INCOMPLETE');
    }
    return { plan: structuredClone(existingPlan), topic: structuredClone(existingTopic), deliveredCount: receipt.questionIds.length,
      questionEvents: [], completionEvents: [], sourceRevision: receipt.sourceRevision, alreadyDelivered: true };
  }

  const source = data.topics.find(topic => topic.id === input.topicId);
  const ownerId = source && topicOwnerId(data, source);
  const owner = data.profiles.find(profile => profile.id === ownerId && profile.familyId === familyId);
  if (!source || !source.libraryPublished && !owner) throw new ApiError(404, '配布する問題集が見つかりません。', 'DELIVERY_SOURCE_NOT_FOUND');
  const sourcePlan = data.plans.find(plan => plan.id === source.planId);
  if (source.testOnly || sourcePlan?.testOnly) throw new ApiError(409, 'テスト用の問題集は学習者に配布できません。', 'DELIVERY_TEST_ONLY');
  if (data.jobs.some(job => job.topicId === source.id && ['queued', 'running'].includes(job.status))) {
    throw new ApiError(409, '問題の作成が終わってから学習者に届けてください。', 'GENERATION_ACTIVE');
  }
  const originals = data.questions.filter(question => question.topicId === source.id && question.status !== 'archived');
  if (!originals.length || originals.length > 300) throw new ApiError(409, '配布できる問題が1〜300問ある問題集を選んでください。', 'DELIVERY_EMPTY_OR_TOO_LARGE');
  if (new Set(originals.map(question => question.id)).size !== originals.length) conflict('問題の番号が重複しています。問題集を確認してください。');
  if (originals.some(question => question.testOnly || data.plans.some(plan => plan.id === question.planId && plan.testOnly))) {
    throw new ApiError(409, 'テスト用の問題を含む問題集は学習者に配布できません。', 'DELIVERY_TEST_ONLY');
  }
  const familyMembers = new Set(data.profiles.filter(profile => profile.familyId === familyId).map(profile => profile.id));
  if (originals.some(question => question.ownerId && !familyMembers.has(question.ownerId)
    || question.audienceUserId && !familyMembers.has(question.audienceUserId))) {
    throw new ApiError(403, 'この問題集の配布範囲を確認できません。', 'DELIVERY_FORBIDDEN');
  }
  if (originals.some(question => !copyableQuestion.safeParse(question).success)) {
    throw new ApiError(409, '問題文・選択肢・正解・解説を確認してから配布してください。', 'DELIVERY_INVALID_QUESTION');
  }
  if (!existingPlan && data.plans.filter(plan => plan.ownerId === learner.id).length >= 100) {
    throw new ApiError(429, '届け先の学習プランは100件までです。', 'PLAN_LIMIT');
  }
  const sourceRevision = hash([source.id, source.title, source.subject, originals.map(question => [question.id, question.version,
    question.status, question.prompt, question.choices, question.correctIndex, question.explanation, question.learningPoint,
    question.needsReview, question.aiGenerated])]);
  if (receipt && receipt.sourceRevision !== sourceRevision) {
    throw new ApiError(409, '配布の途中で元の問題集が変わりました。内容を確認し、新しい配布としてやり直してください。', 'DELIVERY_SOURCE_CHANGED');
  }
  const createdAt = receipt?.createdAt ?? now.toISOString();
  const questions: Question[] = originals.map(original => ({
    id: stableId(['learner-delivery-question', input.requestId, original.id]), topicId, planId,
    ownerId: learner.id, audienceUserId: learner.id, prompt: original.prompt, choices: [...original.choices],
    correctIndex: original.correctIndex, explanation: original.explanation, learningPoint: original.learningPoint,
    sourceIds: [], sourceNote: '管理者から、本人の学習用に届いた問題です。', status: 'published',
    version: 1, createdAt, publishedAt: createdAt, needsReview: !!original.needsReview, aiGenerated: original.aiGenerated,
  }));
  const questionIds = questions.map(question => question.id);
  if (receipt && JSON.stringify(receipt.questionIds) !== JSON.stringify(questionIds)) conflict();
  for (const question of questions) {
    const existing = data.questions.find(item => item.id === question.id);
    // Parsed records may omit undefined optional flags and use a different property order.
    const canonical = (value: Question) => JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))));
    if (existing && canonical(existing) !== canonical(question)) conflict();
  }
  const plan: LearningPlan = { id: planId, ownerId: learner.id, title: source.title.trim().slice(0, 150) || '届いた問題集',
    subject: source.subject, tags, goal: '管理者から届いた問題を練習し、間違えた内容を復習する。', difficulty: '元の問題集の難しさ',
    dailyQuestionTarget: 10, sourceIds: [], requestedQuestionCount: questions.length, version: 1, createdAt, updatedAt: createdAt };
  const topic: Topic = { id: topicId, ownerId: learner.id, audienceUserId: learner.id, planId, title: plan.title,
    subject: source.subject, description: '管理者から届いた、あなたの学習用の問題集です。', targetCount: questions.length, createdAt };
  receipt = { requestId: input.requestId, actorId: administrator.id, sourceTopicId: source.id, learnerId: learner.id,
    tags, sourceRevision, createdAt, planId, topicId, questionIds };
  const event = (suffix: string, type: StudyEvent['type'], payload: object): StudyEvent => ({
    id: `${prefix}${suffix}`, type, actorId: administrator.id, familyId, createdAt, payload: { ...payload, delivery: receipt },
  });
  const questionEvents: StudyEvent[] = [];
  let batch: Question[] = [];
  const flush = () => { if (batch.length) questionEvents.push(event(`questions:${questionEvents.length}`, 'questions.published', { questions: batch })); batch = []; };
  for (const question of questions) {
    if (batch.length && JSON.stringify([...batch, question]).length > 200_000) flush();
    batch.push(question);
  }
  flush();
  return { plan, topic, deliveredCount: questions.length, questionEvents,
    completionEvents: [event('plan', 'plan.created', plan), event('topic', 'topic.created', topic)],
    sourceRevision, alreadyDelivered: false };
}
