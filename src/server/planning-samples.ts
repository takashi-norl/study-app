import { z } from 'zod';
import type { PlanningSample } from '@/lib/types';
import { ApiError } from './config';

export const planningSampleSchema=z.object({
  prompt:z.string().trim().min(5).max(1200),choices:z.array(z.string().trim().min(1).max(300)).length(4),
  correctIndex:z.number().int().min(0).max(3),explanation:z.string().trim().min(5).max(1200),
  learningPoint:z.string().trim().min(1).max(200),sourceIds:z.array(z.string().uuid()).max(20),
  sourceNote:z.string().trim().min(1).max(600),needsReview:z.boolean(),
}).refine(sample=>new Set(sample.choices).size===4,'選択肢の重複');
export const planningSamplesSchema=z.array(planningSampleSchema).length(3).refine(samples=>new Set(samples.map(q=>q.prompt.normalize('NFKC').replace(/\s+/g,''))).size===3,'サンプル設問の重複');
export const sampleJsonSchema={type:'object' as const,additionalProperties:false,properties:{
  prompt:{type:'string'},choices:{type:'array',items:{type:'string'},minItems:4,maxItems:4},correctIndex:{type:'integer',minimum:0,maximum:3},
  explanation:{type:'string'},learningPoint:{type:'string'},sourceIds:{type:'array',items:{type:'string'},maxItems:20},sourceNote:{type:'string'},needsReview:{type:'boolean'},
},required:['prompt','choices','correctIndex','explanation','learningPoint','sourceIds','sourceNote','needsReview']};
export function validateSamples(samples:unknown,sourceIds:string[]):PlanningSample[] {
  const parsed=planningSamplesSchema.safeParse(samples);
  if(!parsed.success) throw new ApiError(409,'先に3問のサンプルを確認してください。相談を送るとサンプルを作れます。','SAMPLES_REQUIRED');
  if(parsed.data.some(sample=>sample.sourceIds.some(id=>!sourceIds.includes(id)) || (sourceIds.length>0 && sample.sourceIds.length===0))) throw new ApiError(422,'サンプルの根拠資料を確認できません。もう一度相談してください。','INVALID_SAMPLE_SOURCE');
  return parsed.data;
}
