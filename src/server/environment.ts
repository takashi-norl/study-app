import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './config';

export type AppEnvironment = 'production' | 'staging' | 'local' | 'misconfigured';
export type ExternalEffect = 'ai' | 'audio' | 'push' | 'workflow';
export const TRUSTED_PROJECTS = {
  production: 'prj_htxD2yC0URXwqtEEffRzi5aK6KjU',
  staging: 'prj_2Ny51kBEY1Y1VyqVThuXlmALj8lA',
} as const;
type Environment = Record<string, string | undefined>;
const cloudRuntime = (env: Environment) => !!(env.VERCEL || env.VERCEL_ENV || env.VERCEL_PROJECT_ID);
const badBinding = () => new ApiError(503, 'この環境の接続設定を確認してください。保存や外部サービスの実行は停止しています。', 'ENVIRONMENT_NOT_BOUND');

/** Display only: never reads credentials or requires cloud setup, including at build time. */
export function getAppEnvironment(env: Environment = process.env): AppEnvironment {
  if (env.APP_ENV !== undefined && !['production', 'staging', 'local'].includes(env.APP_ENV)) return 'misconfigured';
  if (env.VERCEL_PROJECT_ID === TRUSTED_PROJECTS.staging || env.VERCEL_ENV === 'preview') return 'staging';
  if (cloudRuntime(env)) {
    if (env.VERCEL_PROJECT_ID !== TRUSTED_PROJECTS.production || env.VERCEL_ENV !== 'production'
      || env.APP_ENV === 'staging' || env.APP_ENV === 'local') return 'misconfigured';
    return 'production';
  }
  return env.APP_ENV === 'production' || env.APP_ENV === 'staging' ? env.APP_ENV : 'local';
}

const identifier = z.string().trim().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const origin = z.string().url().refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; }
  catch { return false; }
});
const binding = z.object({
  projectId: identifier, workspaceId: identifier, googleClientId: identifier,
  driveFolderId: identifier, sheetsId: identifier, origin,
  authSecretSha256: digest.optional(), aiKeySha256: digest.optional(), audioKeySha256: digest.optional(), pushKeySha256: digest.optional(),
}).strict();
const bindingsSchema = z.object({ production: binding, staging: binding }).strict();
type Binding = z.infer<typeof binding>;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** No setting here grants access. IDs are pins for the separately configured, least-privilege credentials. */
export function assertCloudEnvironment(env: Environment = process.env): { environment: 'production' | 'staging'; binding?: Binding } {
  const project = env.VERCEL_PROJECT_ID;
  const deployment = env.VERCEL_ENV;
  // Temporary compatibility for the one existing production deployment only. A preview, local process,
  // unknown project, explicit APP_ENV, or an attempted binding configuration can never use this path.
  if (env.APP_ENV === undefined && env.APP_ENV_BINDINGS_JSON === undefined
    && project === TRUSTED_PROJECTS.production && deployment === 'production' && env.VERCEL === '1') {
    return { environment: 'production' };
  }
  if (env.VERCEL !== '1' || !['production', 'preview'].includes(deployment ?? '')
    || !['production', 'staging'].includes(env.APP_ENV ?? '')) throw badBinding();
  const environment = env.APP_ENV as 'production' | 'staging';
  if (project !== TRUSTED_PROJECTS[environment] || (environment === 'production' && deployment !== 'production')) throw badBinding();
  let bindings: z.infer<typeof bindingsSchema>;
  try { bindings = bindingsSchema.parse(JSON.parse(env.APP_ENV_BINDINGS_JSON ?? '')); }
  catch { throw badBinding(); }
  for (const name of ['production', 'staging'] as const) if (bindings[name].projectId !== TRUSTED_PROJECTS[name]) throw badBinding();
  for (const key of ['projectId', 'workspaceId', 'googleClientId', 'driveFolderId', 'sheetsId', 'origin'] as const) {
    if (bindings.production[key] === bindings.staging[key]) throw badBinding();
  }
  // The folder and spreadsheet must also differ from *either* production storage ID.
  if ([bindings.staging.driveFolderId, bindings.staging.sheetsId].some(id => [bindings.production.driveFolderId, bindings.production.sheetsId].includes(id))) throw badBinding();
  // Pins detect replacement of reviewed credentials. They do not prove provider-account provenance.
  // If an operator has supplied both fingerprints, also reject a copied production credential.
  for (const key of ['authSecretSha256', 'aiKeySha256', 'audioKeySha256', 'pushKeySha256'] as const) {
    if (bindings.production[key] && bindings.production[key] === bindings.staging[key]) throw badBinding();
  }
  const current = bindings[environment];
  const settings = { workspaceId: 'WORKSPACE_ID', googleClientId: 'GOOGLE_CLIENT_ID', driveFolderId: 'GOOGLE_DRIVE_FOLDER_ID', sheetsId: 'GOOGLE_SHEETS_ID', origin: 'NEXTAUTH_URL' } as const;
  for (const [key, name] of Object.entries(settings) as [keyof typeof settings, string][]) {
    if (env[name]?.trim() !== current[key]) throw badBinding();
  }
  if (env.NEXT_PUBLIC_APP_URL && env.NEXT_PUBLIC_APP_URL.trim() !== current.origin) throw badBinding();
  if (environment === 'staging' && (!current.authSecretSha256 || !env.NEXTAUTH_SECRET
    || sha256(env.NEXTAUTH_SECRET) !== current.authSecretSha256)) throw badBinding();
  return { environment, binding: current };
}

const flags: Record<ExternalEffect, string> = {
  ai: 'AI_GENERATION_ENABLED', audio: 'AUDIO_GENERATION_ENABLED', push: 'PUSH_NOTIFICATIONS_ENABLED', workflow: 'WORKFLOW_EXECUTION_ENABLED',
};
const secretBindings = {
  ai: ['ANTHROPIC_API_KEY', 'aiKeySha256'], audio: ['ELEVENLABS_API_KEY', 'audioKeySha256'], push: ['VAPID_PRIVATE_KEY', 'pushKeySha256'],
} as const;

/** Must run before reservations, dispatch, and again immediately before the external provider call. */
export function assertExternalEffectAllowed(effect: ExternalEffect, env: Environment = process.env): void {
  const context = assertCloudEnvironment(env);
  const value = env[flags[effect]];
  // Existing production behavior stays intact during rollout; explicit false still stops an effect.
  const enabled = value === 'true' || (context.environment === 'production' && effect !== 'ai' && value === undefined);
  if (!enabled) throw new ApiError(503, 'この環境ではこの機能を停止しています。', 'EXTERNAL_EFFECT_DISABLED');
  if (context.environment === 'staging' && effect !== 'workflow') {
    const [secretName, pinName] = secretBindings[effect];
    const secret = env[secretName]?.trim(), pin = context.binding?.[pinName];
    if (!secret || !pin || sha256(secret) !== pin) throw badBinding();
  }
}

/** UI capability checks must never turn a configuration error into permission to execute. */
export function externalEffectEnabled(effect: ExternalEffect): boolean {
  try { assertExternalEffectAllowed(effect); return true; } catch { return false; }
}
