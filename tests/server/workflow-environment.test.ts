import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { TRUSTED_PROJECTS } from '../../src/server/environment';
import { beginGeneration, analyzeSource, planBatches, generateBatch, finishGeneration, failGeneration } from '../../src/workflows/generation-steps';
import { beginPlanning, analyzePlanningSource, completePlanning, failPlanning } from '../../src/workflows/planning-steps';
import { vocabularyBuildInput, buildVocabularyWord } from '../../src/workflows/vocabulary-audio-steps';
import { retryGeneration } from '../../src/server/generation-retry';

test('queued workers and retry dispatch stop before storage or providers when workflow execution is disabled', async () => {
  const env: Record<string, string | undefined> = {
    VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: TRUSTED_PROJECTS.production,
    APP_ENV: undefined, APP_ENV_BINDINGS_JSON: undefined, WORKFLOW_EXECUTION_ENABLED: 'false',
  };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  let requests = 0;
  const network = mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Must not reach network'); });
  try {
    for (const step of [
      () => beginGeneration('job'), () => analyzeSource('job', 'source'), () => planBatches('job'),
      () => generateBatch('job', 0, 1), () => finishGeneration('job'), () => failGeneration('job', 'failed'),
      () => beginPlanning('turn'), () => analyzePlanningSource('turn', 'source'),
      () => completePlanning('turn'), () => failPlanning('turn', 'failed'),
      () => vocabularyBuildInput('actor'), () => buildVocabularyWord('actor', 'word'),
    ]) await assert.rejects(step, /バックグラウンド処理を停止/);
    await assert.rejects(() => retryGeneration({ id: 'learner', workspaceId: 'workspace', name: 'Learner', accessLevel: 'learner' }, 'job', 'request'), { code: 'EXTERNAL_EFFECT_DISABLED' });
    assert.equal(requests, 0);
  } finally {
    network.mock.restore();
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
