import { z } from 'zod';
import { start, getHookByToken, getRun } from 'workflow/api';
import { HookNotFoundError } from 'workflow/errors';
import { requireSuperUser } from '@/server/auth';
import { vocabularyPreview } from '@/server/vocabulary-samples';
import { vocabularyAudioWorkflow } from '@/workflows/vocabulary-audio';
import { api, readJson } from '@/server/http';
import { assertExternalEffectAllowed } from '@/server/environment';

async function running() {
  try {
    const hook = await getHookByToken('hibi-vocabulary-audio-100-v1');
    const status = await getRun(hook.runId).status;
    return status === 'running' || status === 'pending';
  } catch (error) { if (HookNotFoundError.is(error)) return false; throw error; }
}
export async function GET() {
  return api(async () => {
    const { profile } = await requireSuperUser();
    const preview = await vocabularyPreview(profile);
    return { total: preview.audio.length, ready: preview.audio.filter(item => item.state === 'ready').length,
      failed: preview.audio.filter(item => item.state === 'failed').length,
      pending: preview.audio.filter(item => item.state === 'pending').length,
      missing: preview.audio.filter(item => item.state === 'missing').length, running: await running() };
  });
}
export async function POST(request: Request) {
  return api(async () => {
    const { profile } = await requireSuperUser();
    await readJson(request, z.object({}).strict());
    assertExternalEffectAllowed('workflow');
    assertExternalEffectAllowed('audio');
    if (await running()) return { accepted: true };
    const preview = await vocabularyPreview(profile);
    if (!preview.audio.some(item => item.state === 'missing')) return { accepted: true };
    await start(vocabularyAudioWorkflow, [profile.id]);
    return { accepted: true };
  });
}
