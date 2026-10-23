import { requireProfile } from '@/server/auth';
import { vocabularyPreview } from '@/server/vocabulary-samples';
import { api } from '@/server/http';

export async function GET() {
  return api(async () => vocabularyPreview((await requireProfile('parent')).profile));
}
