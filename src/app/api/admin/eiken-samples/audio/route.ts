import { z } from 'zod';
import { requireProfile } from '@/server/auth';
import { prepareSampleAudio, readSampleAudio, sampleAudioResponse } from '@/server/eiken-samples';
import { api, readJson } from '@/server/http';

export const maxDuration = 180;
export async function POST(request: Request) {
  return api(async () => {
    const { profile } = await requireProfile('parent');
    const { sampleId } = await readJson(request, z.object({ sampleId: z.string().max(60) }).strict());
    return prepareSampleAudio(profile, sampleId);
  });
}
async function serve(request: Request, head = false) {
  try {
    const { profile } = await requireProfile('parent');
    const bytes = await readSampleAudio(profile, new URL(request.url).searchParams.get('sampleId') ?? '');
    return sampleAudioResponse(bytes, request.headers.get('range'), head);
  } catch (error) { return api(async () => { throw error; }); }
}
export async function GET(request: Request) { return serve(request); }
export async function HEAD(request: Request) { return serve(request, true); }
