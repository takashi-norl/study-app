import { requireSuperUser } from '@/server/auth';
import { summarizeOperationalAiUsage } from '@/server/ai-usage';
import { loadEvents } from '@/server/google-store';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export async function GET() {
  return api(async () => {
    await requireSuperUser();
    return { summary: summarizeOperationalAiUsage(await loadEvents()) };
  });
}
