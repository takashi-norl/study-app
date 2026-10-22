import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { api, readJson } from '@/server/http';
import { retryGeneration } from '@/server/generation-retry';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const { profile } = await requireProfile();
    const input = await readJson(request, z.object({ requestId: z.string().uuid() }).strict());
    const { id } = await context.params;
    z.string().uuid().parse(id);
    return retryGeneration(profile, id, input.requestId);
  }, 202);
}
