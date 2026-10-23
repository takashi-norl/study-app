import { z } from 'zod';

export const QUESTION_SET_IMPORT_BYTES = 120 * 1024;
const nonempty = (max: number) => z.string().trim().min(1).max(max);
const question = z.object({
  prompt: nonempty(3000), choices: z.array(nonempty(600)).length(4),
  correctIndex: z.number().int().min(0).max(3), explanation: nonempty(3000),
  learningPoint: nonempty(600), sourceIds: z.array(z.string().uuid()).max(20), sourceNote: nonempty(2000),
}).strict().refine(q => new Set(q.choices.map(c=>c.normalize('NFKC').replace(/\s+/g,''))).size===4, '選択肢が重複しています。');
export const questionSetBundleSchema = z.object({
  version: z.literal(1), bundleId: z.string().uuid(), title: nonempty(150), subject: nonempty(40),
  description: z.string().trim().max(2000), planId: z.string().uuid().optional(),
  questionTemplate: z.literal('kobun-vocabulary').optional(),
  questions: z.array(question).min(1).max(100),
}).strict().refine(b => !b.questionTemplate || b.subject==='古文', '古文単語の形式は古文で選んでください。')
  .refine(b => new Set(b.questions.map(q=>q.prompt.normalize('NFKC').replace(/\s+/g,''))).size===b.questions.length, '同じ問題文が重複しています。');
export const questionSetImportSchema = z.object({bundle:questionSetBundleSchema, reviewed:z.literal(true)}).strict();
export type QuestionSetBundle = z.infer<typeof questionSetBundleSchema>;
