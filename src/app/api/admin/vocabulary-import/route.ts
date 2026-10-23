import { requireSuperUser } from '@/server/auth';
import { api } from '@/server/http';
import { importVocabularyAudio, readVocabularyImport } from '@/server/vocabulary-import';

export const maxDuration = 180;
export async function POST(request: Request) {
  return api(async () => {
    const { profile } = await requireSuperUser();
    return importVocabularyAudio(profile, await readVocabularyImport(request));
  });
}
