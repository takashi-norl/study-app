import 'server-only';
import type { AiFeature } from '@/lib/ai-usage';
import { ApiError } from './config';

export type AiModelProfile = 'legacy' | 'economy';
/** A model-selection stage does not introduce a new usage-ledger event or feature. */
export type AiModelStage = AiFeature | 'question-verification';
export type AiModelEnvironment = Readonly<Record<string, string | undefined>>;
export interface AiModelPolicyOptions {
  /** Server-selected only. Leaving this unset preserves the deployment's explicit profile. */
  profile?: AiModelProfile;
  /** Injectable configuration keeps policy tests independent of deployment credentials. */
  env?: AiModelEnvironment;
}

export const ECONOMY_AI_MODELS = {
  'source-analysis': 'claude-haiku-5-5',
  'question-generation': 'claude-haiku-5-5',
  planning: 'claude-sonnet-5-5',
  'question-verification': 'claude-sonnet-5-5',
} as const;

const overrideNames: Record<AiModelStage, string> = {
  'source-analysis': 'ANTHROPIC_SOURCE_MODEL',
  'question-generation': 'ANTHROPIC_DRAFT_MODEL',
  planning: 'ANTHROPIC_PLANNING_MODEL',
  'question-verification': 'ANTHROPIC_VERIFICATION_MODEL',
  profile: 'ANTHROPIC_PROFILE_MODEL',
};

/** No implicit rollout: an unset profile retains the existing single-model behavior. */
export function resolveAiModelProfile(options: AiModelPolicyOptions = {}): AiModelProfile {
  const profile = options.profile ?? (options.env ?? process.env).AI_MODEL_PROFILE?.trim() ?? 'legacy';
  if (profile === '' || profile === 'legacy') return 'legacy';
  if (profile === 'economy') return 'economy';
  throw new ApiError(503, 'AI_MODEL_PROFILEはlegacyまたはeconomyを指定してください。', 'INVALID_AI_MODEL_POLICY');
}

function configuredModel(env: AiModelEnvironment, name: string): string | undefined {
  const model = env[name]?.trim();
  if (!model) return undefined;
  if (model.length > 150 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(model)) {
    throw new ApiError(503, `${name}のモデル指定を確認してください。`, 'INVALID_AI_MODEL_POLICY');
  }
  return model;
}

/**
 * Stage override > explicitly selected economy defaults > legacy ANTHROPIC_MODEL.
 * Selecting economy deliberately replaces only the legacy global default, never a stage override.
 * This is a configurable cost policy, not a claim that the cheaper model passed a quality review.
 * Personal-profile conversations keep the legacy model until separately evaluated.
 * Callers still enforce AI availability, consent, quotas, and output verification.
 */
export function resolveAiModel(stage: AiModelStage, options: AiModelPolicyOptions = {}): string {
  const env = options.env ?? process.env;
  const profile = resolveAiModelProfile({ ...options, env });
  if (!Object.hasOwn(overrideNames, stage)) {
    throw new ApiError(503, 'AIの処理種別を確認してください。', 'INVALID_AI_MODEL_POLICY');
  }
  const override = configuredModel(env, overrideNames[stage]);
  if (override) return override;
  if (profile === 'economy' && stage !== 'profile') return ECONOMY_AI_MODELS[stage];
  const legacy = configuredModel(env, 'ANTHROPIC_MODEL');
  if (legacy) return legacy;
  throw new ApiError(503, 'ANTHROPIC_MODELの設定が必要です。', 'NOT_CONFIGURED');
}
