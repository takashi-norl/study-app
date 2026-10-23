import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { appendEvent, getFullState } from '@/server/google-store';
import { ApiError } from '@/server/config';
import { api, readJson } from '@/server/http';
import { prepareSourceAnalysisUpdate, requireSourceAnalysisAccess, sourceAnalysisView } from '@/server/source-analysis';
import { sourceAnalysisUpdateSchema } from '@/server/source-analysis-schema';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { profile } = await requireProfile();
    const id = z.string().uuid().parse((await context.params).id);
    const { data, events } = await getFullState();
    requireSourceAnalysisAccess(data, profile, id);
    return sourceAnalysisView(events, id);
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { profile } = await requireProfile();
    const id = z.string().uuid().parse((await context.params).id);
    const input = await readJson(request, sourceAnalysisUpdateSchema);
    const { data, events } = await getFullState();
    const prepared = prepareSourceAnalysisUpdate(data, events, profile, id, input);
    if (!prepared.event) return prepared.view;
    await appendEvent(prepared.event);
    const stored = await getFullState();
    requireSourceAnalysisAccess(stored.data, profile, id);
    const winner = stored.events.find(event => event.id === prepared.event!.id);
    const view = sourceAnalysisView(stored.events, id);
    if (winner?.type !== 'source.analysis' || winner.payload.requestId !== input.requestId || view.revision !== prepared.event.id) {
      throw new ApiError(409, '別の画面で読み取りが更新されました。最新の内容を確認してください。', 'SOURCE_ANALYSIS_CONFLICT');
    }
    return view;
  });
}
