import { requireProfile } from '@/server/auth';
import { api } from '@/server/http';
import { sharingUnavailable } from '@/server/private-self-study';

export async function GET() { return api(async () => {
  await requireProfile();
  return sharingUnavailable();
}); }
