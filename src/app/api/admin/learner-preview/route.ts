import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { getFullState } from '@/server/google-store';
import { api } from '@/server/http';
import { prepareLearnerPreview } from '@/server/learner-preview';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return api(async () => {
    const { profile } = await requireProfile('parent');
    const learnerId = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/)
      .parse(new URL(request.url).searchParams.get('learnerId'));
    const { data } = await getFullState();
    return prepareLearnerPreview(data, profile, learnerId);
  });
}
