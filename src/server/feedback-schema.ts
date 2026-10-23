import { z } from 'zod';

export const feedbackInputSchema = z.object({
  requestId: z.string().uuid(),
  category: z.enum(['困った', 'よかった', 'ほしい']),
  message: z.string().trim().min(1).max(1200),
}).strict();

export const feedbackSubmittedSchema = z.object({
  userId: z.string().min(1).max(200),
  category: z.enum(['困った', 'よかった', 'ほしい']),
  message: z.string().trim().min(1).max(1200),
  version: z.string().min(1).max(30),
}).strict();
