import { requireSuperUser } from '@/server/auth';
import { summarizeAiUsage } from '@/server/ai-usage';
import { getFamilyMembers, profileForMember } from '@/server/env';
import { loadEvents } from '@/server/google-store';
import { api } from '@/server/http';

export const dynamic = 'force-dynamic';
export async function GET() {
  return api(async () => {
    await requireSuperUser();
    return { summary: summarizeAiUsage(await loadEvents(), getFamilyMembers().map(profileForMember)) };
  });
}
