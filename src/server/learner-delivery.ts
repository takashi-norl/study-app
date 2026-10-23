import 'server-only';
import { z } from 'zod';
import type { LearningPlan, Profile, StudyData, Topic } from '@/lib/types';
import type { StudyEvent } from './google-store';
import { planTagsSchema } from './plan-tags';
import { sharingUnavailable } from './private-self-study';

export const learnerDeliverySchema = z.object({
  topicId: z.string().uuid(), learnerId: z.string().min(1).max(100), requestId: z.string().uuid(),
  projectName: z.string().trim().min(1).max(40).optional(), tags: planTagsSchema.optional(),
}).strict();
export type LearnerDeliveryInput = z.infer<typeof learnerDeliverySchema>;

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


/** Historical delivery records remain readable by their owner; new deliveries are disabled. */
export function prepareLearnerDelivery(_data: StudyData, _events: StudyEvent[], _actor: Profile,
  _rawInput: LearnerDeliveryInput, _now = new Date()): PreparedLearnerDelivery {
  return sharingUnavailable();
}
