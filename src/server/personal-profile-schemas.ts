import { z } from 'zod';

const ownerIdSchema = z.string().min(1).max(200);
const versionSchema = z.number().int().min(0);
export const personalPreferencesSchema = z.object({
  nickname: z.string().trim().max(40),
  schoolYear: z.string().trim().max(80),
  goals: z.string().trim().max(400),
  interests: z.string().trim().max(240),
  encouragementStyle: z.enum(['gentle', 'direct', 'energetic']),
  dailyMinutes: z.number().int().min(1).max(120),
  enabled: z.boolean(),
  personalizedMessages: z.array(z.string().trim().min(1).max(100)).max(6),
}).strict();

export const personalProfileSaveSchema = z.object({
  requestId: z.string().uuid(), expectedVersion: versionSchema, preferences: personalPreferencesSchema,
}).strict();
export const personalProfileChatSchema = z.object({
  requestId: z.string().uuid(), expectedVersion: versionSchema, message: z.string().trim().min(1).max(1500),
}).strict();
export const personalProfileSavedEventSchema = personalProfileSaveSchema.extend({ownerId: ownerIdSchema});
export const personalProfileChatRequestedEventSchema = personalProfileChatSchema.extend({
  ownerId: ownerIdSchema, executionToken: z.string().uuid(),
});
const completedBase = z.object({ownerId: ownerIdSchema, requestId: z.string().uuid(), version: versionSchema.min(1), executionToken: z.string().uuid()}).strict();
export const personalProfileChatCompletedEventSchema = completedBase.extend({
  reply: z.string().trim().min(1).max(2000), draft: personalPreferencesSchema,
});
export const personalProfileChatFailedEventSchema = completedBase.extend({error: z.string().min(1).max(200)});
export const personalProfileReplySchema = z.object({
  reply: z.string().trim().min(1).max(2000),
  draft: personalPreferencesSchema.extend({personalizedMessages: z.array(z.string().trim().min(1).max(100)).min(3).max(6)}),
}).strict();
