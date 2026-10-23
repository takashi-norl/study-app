import { z } from 'zod';

/** Saved section boundaries let one cached recording serve four independent play buttons. */
export const audioSegmentsSchema = z.array(z.object({
  id: z.enum(['word', 'example-1', 'example-2', 'example-3']),
  startSeconds: z.number().finite().min(0).max(180),
  endSeconds: z.number().finite().positive().max(180),
}).strict()).length(4).refine(segments => segments.every((segment, index) =>
  segment.id === ['word', 'example-1', 'example-2', 'example-3'][index]
  && segment.endSeconds > segment.startSeconds
  && (index === 0 || segment.startSeconds >= segments[index - 1].endSeconds)), 'Invalid audio sections');
export type AudioSegment = z.infer<typeof audioSegmentsSchema>[number];
