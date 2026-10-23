import { requireProfile } from '@/server/auth';
import { samplePreview } from '@/server/eiken-samples';
import { api } from '@/server/http';

export async function GET() {
  return api(async () => samplePreview((await requireProfile()).profile));
}
