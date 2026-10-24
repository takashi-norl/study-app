import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';
import { assertCloudEnvironment, assertExternalEffectAllowed, getAppEnvironment, TRUSTED_PROJECTS } from '../../src/server/environment';
import { getAuthConfig, getDriveConfig, assertStorageGrant } from '../../src/server/env';
import { requireGenerationEnabled } from '../../src/server/config';
import { createProviderAudio } from '../../src/server/audio';
import { createSampleProviderAudio, sampleAudioSpec } from '../../src/server/eiken-samples';
import { createVocabularyProviderAudio, vocabularyAudioSpec } from '../../src/server/vocabulary-audio';
import { vocabularyEntry } from '../../src/server/vocabulary-samples';
import { notifyPublished } from '../../src/server/push';
import { loadEvents } from '../../src/server/google-store';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = 'a-staging-only-synthetic-session-secret-32';
function configured() {
  const bindings = {
    production: { projectId: TRUSTED_PROJECTS.production, workspaceId: 'production-workspace', googleClientId: 'production-client', driveFolderId: 'production-folder', sheetsId: 'production-sheet', origin: 'https://production.example' },
    staging: { projectId: TRUSTED_PROJECTS.staging, workspaceId: 'staging-workspace', googleClientId: 'staging-client', driveFolderId: 'staging-folder', sheetsId: 'staging-sheet', origin: 'https://staging.example', authSecretSha256: hash(secret), aiKeySha256: hash('staging-ai'), audioKeySha256: hash('staging-audio'), pushKeySha256: hash('staging-push') },
  };
  const env: Record<string, string | undefined> = {
    VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: TRUSTED_PROJECTS.staging, APP_ENV: 'staging',
    APP_ENV_BINDINGS_JSON: JSON.stringify(bindings), WORKSPACE_ID: bindings.staging.workspaceId,
    GOOGLE_CLIENT_ID: bindings.staging.googleClientId, GOOGLE_CLIENT_SECRET: 'staging-client-secret',
    GOOGLE_DRIVE_FOLDER_ID: bindings.staging.driveFolderId, GOOGLE_SHEETS_ID: bindings.staging.sheetsId,
    GOOGLE_DRIVE_REFRESH_TOKEN: 'staging-refresh', NEXTAUTH_SECRET: secret, NEXTAUTH_URL: bindings.staging.origin,
    NEXT_PUBLIC_APP_URL: bindings.staging.origin, ANTHROPIC_API_KEY: 'staging-ai', ANTHROPIC_MODEL: 'test-model',
    ELEVENLABS_API_KEY: 'staging-audio', VAPID_PRIVATE_KEY: 'staging-push', NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'staging-public', VAPID_SUBJECT: 'mailto:staging@example.com',
    AI_GENERATION_ENABLED: undefined, AUDIO_GENERATION_ENABLED: undefined, PUSH_NOTIFICATIONS_ENABLED: undefined, WORKFLOW_EXECUTION_ENABLED: undefined,
  };
  return { env, bindings };
}
async function withEnvironment(env: Record<string, string | undefined>, action: () => void | Promise<void>) {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { await action(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('identity remains viewable without cloud setup and does not disguise preview or unknown deployments as production', () => {
  assert.equal(getAppEnvironment({}), 'local');
  assert.equal(getAppEnvironment({ APP_ENV: 'staging' }), 'staging');
  assert.equal(getAppEnvironment({ VERCEL: '1', VERCEL_PROJECT_ID: TRUSTED_PROJECTS.staging }), 'staging');
  assert.equal(getAppEnvironment({ VERCEL_ENV: 'preview', APP_ENV: 'production', VERCEL_PROJECT_ID: TRUSTED_PROJECTS.production }), 'staging');
  assert.equal(getAppEnvironment({ VERCEL: '1', APP_ENV: 'production', VERCEL_PROJECT_ID: 'unknown' }), 'misconfigured');
  assert.equal(getAppEnvironment({ APP_ENV: 'stagin' }), 'misconfigured');
});

test('only the exact old production project and production target can use the temporary compatibility path', () => {
  const legacy = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: TRUSTED_PROJECTS.production };
  assert.deepEqual(assertCloudEnvironment(legacy), { environment: 'production' });
  for (const env of [{}, { ...legacy, VERCEL: undefined }, { ...legacy, VERCEL_ENV: 'preview' }, { ...legacy, VERCEL_PROJECT_ID: TRUSTED_PROJECTS.staging }, { ...legacy, VERCEL_PROJECT_ID: 'untrusted' }, { ...legacy, APP_ENV: 'production' }, { ...legacy, APP_ENV: 'local' }, { ...legacy, APP_ENV_BINDINGS_JSON: '{}' }]) {
    assert.throws(() => assertCloudEnvironment(env), { code: 'ENVIRONMENT_NOT_BOUND' });
  }
});

test('configured staging pins both project and storage identity and rejects every production crossover', () => {
  const { env, bindings } = configured();
  assert.equal(assertCloudEnvironment(env).environment, 'staging');
  for (const change of [
    { APP_ENV: undefined }, { APP_ENV: 'production' }, { VERCEL_PROJECT_ID: TRUSTED_PROJECTS.production }, { APP_ENV_BINDINGS_JSON: undefined },
    { WORKSPACE_ID: bindings.production.workspaceId }, { GOOGLE_CLIENT_ID: bindings.production.googleClientId },
    { GOOGLE_DRIVE_FOLDER_ID: bindings.production.driveFolderId }, { GOOGLE_SHEETS_ID: bindings.production.sheetsId },
    { NEXTAUTH_URL: bindings.production.origin }, { NEXT_PUBLIC_APP_URL: bindings.production.origin }, { NEXTAUTH_SECRET: 'copied-or-replaced-secret' },
  ]) assert.throws(() => assertCloudEnvironment({ ...env, ...change }), { code: 'ENVIRONMENT_NOT_BOUND' });
  for (const field of ['workspaceId', 'googleClientId', 'driveFolderId', 'sheetsId', 'origin'] as const) {
    const bad = structuredClone(bindings); bad.staging[field] = bad.production[field];
    assert.throws(() => assertCloudEnvironment({ ...env, APP_ENV_BINDINGS_JSON: JSON.stringify(bad) }), { code: 'ENVIRONMENT_NOT_BOUND' });
  }
  const swapped = structuredClone(bindings); swapped.staging.driveFolderId = swapped.production.sheetsId;
  assert.throws(() => assertCloudEnvironment({ ...env, APP_ENV_BINDINGS_JSON: JSON.stringify(swapped) }), { code: 'ENVIRONMENT_NOT_BOUND' });
  const copiedPin = { ...bindings, production: { ...bindings.production, authSecretSha256: bindings.staging.authSecretSha256 } };
  assert.throws(() => assertCloudEnvironment({ ...env, APP_ENV_BINDINGS_JSON: JSON.stringify(copiedPin) }), { code: 'ENVIRONMENT_NOT_BOUND' });
  assert.throws(() => assertStorageGrant({ aud: bindings.production.googleClientId, scopes: ['https://www.googleapis.com/auth/drive.file'] }, { clientId: bindings.staging.googleClientId }), { code: 'INVALID_GOOGLE_SCOPE' });
});

test('staging and preview external effects default off; each opt-in needs its own isolated credential pin', () => {
  const { env } = configured();
  const flags = { ai: 'AI_GENERATION_ENABLED', audio: 'AUDIO_GENERATION_ENABLED', push: 'PUSH_NOTIFICATIONS_ENABLED', workflow: 'WORKFLOW_EXECUTION_ENABLED' } as const;
  for (const target of ['production', 'preview']) for (const effect of ['ai', 'audio', 'push', 'workflow'] as const) {
    const current = { ...env, VERCEL_ENV: target };
    assert.throws(() => assertExternalEffectAllowed(effect, current), { code: 'EXTERNAL_EFFECT_DISABLED' });
    assert.doesNotThrow(() => assertExternalEffectAllowed(effect, { ...current, [flags[effect]]: 'true' }));
    assert.throws(() => assertExternalEffectAllowed(effect, { ...current, [flags[effect]]: 'TRUE' }), { code: 'EXTERNAL_EFFECT_DISABLED' });
  }
  for (const [effect, name] of [['ai', 'ANTHROPIC_API_KEY'], ['audio', 'ELEVENLABS_API_KEY'], ['push', 'VAPID_PRIVATE_KEY']] as const) {
    assert.throws(() => assertExternalEffectAllowed(effect, { ...env, [flags[effect]]: 'true', [name]: 'unreviewed-or-copied-key' }), { code: 'ENVIRONMENT_NOT_BOUND' });
  }
  const legacy = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: TRUSTED_PROJECTS.production };
  assert.doesNotThrow(() => assertExternalEffectAllowed('workflow', legacy));
  assert.throws(() => assertExternalEffectAllowed('workflow', { ...legacy, WORKFLOW_EXECUTION_ENABLED: 'false' }), { code: 'EXTERNAL_EFFECT_DISABLED' });
});

test('missing staging bindings stop authentication, storage and AI before any external request', async () => {
  const { env } = configured(); env.APP_ENV_BINDINGS_JSON = undefined; env.AI_GENERATION_ENABLED = 'true';
  await withEnvironment(env, async () => {
    let calls = 0;
    const network = mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Network must not be reached'); });
    try {
      assert.throws(getAuthConfig, { code: 'ENVIRONMENT_NOT_BOUND' });
      assert.throws(getDriveConfig, { code: 'ENVIRONMENT_NOT_BOUND' });
      assert.throws(requireGenerationEnabled, { code: 'ENVIRONMENT_NOT_BOUND' });
      await assert.rejects(loadEvents, { code: 'ENVIRONMENT_NOT_BOUND' });
      assert.equal(calls, 0);
    } finally { network.mock.restore(); }
  });
});

test('all audio provider entry points and push delivery honor the disabled staging guard', async () => {
  await withEnvironment(configured().env, async () => {
    let calls = 0;
    const network = mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Network must not be reached'); });
    try {
      await assert.rejects(() => createProviderAudio('Hello.', 'JBFqnCBsd6RMkjVDRZzb', 'staging-audio'), { code: 'EXTERNAL_EFFECT_DISABLED' });
      await assert.rejects(() => createSampleProviderAudio(sampleAudioSpec('grade2-listening')), { code: 'EXTERNAL_EFFECT_DISABLED' });
      await assert.rejects(() => createVocabularyProviderAudio(vocabularyAudioSpec(vocabularyEntry('avoid'))), { code: 'EXTERNAL_EFFECT_DISABLED' });
      assert.deepEqual(await notifyPublished(['example-question']), { sent: 0, failed: 0 });
      assert.equal(calls, 0);
    } finally { network.mock.restore(); }
  });
});
