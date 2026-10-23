import { z } from 'zod';

export const analysisSchema = z.object({
  text: z.string().trim().min(1).max(18000),
  learningPoints: z.array(z.string().trim().min(1).max(300)).max(80),
  uncertainties: z.array(z.string().trim().min(1).max(300)).max(50),
});

export const sourceAnalysisUpdateSchema = analysisSchema.extend({
  requestId: z.string().uuid(), expectedRevision: z.string().min(1).max(200).nullable(),
}).strict();

/** Keep the existing event type readable by older deployments; revisions are append-only. */
export const sourceAnalysisRevisionSchema = z.object({
  sourceId: z.string().min(1).max(200), text: z.string().min(1).max(100000),
  revision: z.number().int().positive(), previousRevision: z.string().min(1).max(200).nullable(),
  requestId: z.string().uuid(), reviewed: z.literal(true),
}).strict().refine(value => {
  try { return analysisSchema.safeParse(JSON.parse(value.text)).success; } catch { return false; }
}, '読み取り内容を確認してください。');
