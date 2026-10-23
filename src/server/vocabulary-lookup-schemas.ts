import { z } from 'zod';
export const vocabularyLookupSchema = z.object({
  requestId: z.string().uuid(), termId: z.string().min(1).max(100),
  action: z.enum(['lookup', 'practice', 'known']),
}).strict();
