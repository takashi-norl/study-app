import { z } from 'zod';
import { requireProfile, requireSuperUser } from '@/server/auth';
import { prepareVocabularyAudio, readVocabularyAudio } from '@/server/vocabulary-samples';
import { sampleAudioResponse } from '@/server/eiken-samples';
import { api, readJson } from '@/server/http';

export const maxDuration = 180;
export async function POST(request: Request) {
  return api(async () => {
    const { profile } = await requireSuperUser();
    const { wordId } = await readJson(request, z.object({ wordId: z.string().max(60) }).strict());
    return prepareVocabularyAudio(profile, wordId);
  });
}
async function serve(request: Request, head = false) {
  try {
    const { profile } = await requireProfile();
    const query = new URL(request.url).searchParams;
    const bytes = await readVocabularyAudio(profile, query.get('wordId') ?? '', query.get('batch') ?? undefined);
    return sampleAudioResponse(bytes, request.headers.get('range'), head);
  } catch (error) { return api(async () => { throw error; }); }
}
export async function GET(request: Request) { return serve(request); }
export async function HEAD(request: Request) { return serve(request, true); }
