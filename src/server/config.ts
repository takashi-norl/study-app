import 'server-only';
import { assertExternalEffectAllowed } from './environment';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED') {
    super(message);
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ApiError(503, `クラウド接続の設定が必要です (${name})。デモとは別の環境です。`, 'NOT_CONFIGURED');
  return value;
}

export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const SOURCE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;

export function requireGenerationEnabled() {
  if (process.env.AI_GENERATION_ENABLED !== 'true') throw new ApiError(503,'AI作問はまだ有効になっていません。利用費用の上限を確認してから管理者が有効にしてください。','AI_DISABLED');
  assertExternalEffectAllowed('ai');
  requiredEnv('ANTHROPIC_API_KEY');
  requiredEnv('ANTHROPIC_MODEL');
}
