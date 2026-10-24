import { afterEach, beforeEach } from 'node:test';
import { TRUSTED_PROJECTS } from '../../src/server/environment';

// These tests replace every provider call. Explicitly exercise the supported old production
// deployment instead of treating an unconfigured local/test process as a cloud deployment.
const runtime = {
  VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: TRUSTED_PROJECTS.production,
  APP_ENV: undefined, APP_ENV_BINDINGS_JSON: undefined,
  AUDIO_GENERATION_ENABLED: undefined, PUSH_NOTIFICATIONS_ENABLED: undefined, WORKFLOW_EXECUTION_ENABLED: undefined,
};
let previous: Record<string, string | undefined>;
beforeEach(() => {
  previous = Object.fromEntries(Object.keys(runtime).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(runtime)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
