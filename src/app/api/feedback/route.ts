import { requireProfile, requireSuperUser } from '@/server/auth';
import { api, readJson } from '@/server/http';
import { loadOperationsEvents, appendEvent } from '@/server/google-store';
import { feedbackInputSchema } from '@/server/feedback-schema';
import { prepareFeedback } from '@/server/feedback';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return api(async () => {
    const { profile } = await requireProfile();
    const input = await readJson(request, feedbackInputSchema);
    const event = prepareFeedback(await loadOperationsEvents(), profile, input);
    if (event) await appendEvent(event);
    return { received: true };
  });
}

export async function GET() {
  return api(async () => {
    await requireSuperUser();
    const feedback = (await loadOperationsEvents()).filter(event => event.type === 'feedback.submitted').slice(-100).reverse()
      .map(event => ({ id: event.id, createdAt: event.createdAt, category: event.payload.category, message: event.payload.message, version: event.payload.version }));
    return { feedback };
  });
}
