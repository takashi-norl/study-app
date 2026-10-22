export type AiFeature = 'source-analysis' | 'question-generation' | 'planning' | 'profile';
export interface AiUsageTotals {
  requests: number;
  completed: number;
  failed: number;
  unresolved: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of priced requests only. Unknown charges are counted separately, never treated as zero. */
  estimatedUsd: number;
  unknownCostRequests: number;
}
export interface AiUsageSummary {
  currency: 'USD';
  estimated: true;
  trackingSince: string | null;
  pricingAsOf: string;
  pricingUrl: string;
  month: string;
  monthly: AiUsageTotals;
  allTime: AiUsageTotals;
  byFeature: Array<{ feature: AiFeature; usage: AiUsageTotals }>;
  byUser: Array<{ userId: string; name: string; usage: AiUsageTotals }>;
  elevenLabs: { requests: number; characters: number; ready: number; failed: number; unresolved: number; estimatedUsd: null };
  notes: string[];
}
