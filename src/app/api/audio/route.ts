import { requireProfile } from '@/server/auth';
import { audioConfigured, audioRequestSchema, questionAudio } from '@/server/audio';
import { api, readJson } from '@/server/http';

export const maxDuration=180;
export async function GET() {return api(async()=>{await requireProfile();return {configured:audioConfigured()};});}
export async function POST(request:Request) {
  try {
    const {profile}=await requireProfile();
    const input=await readJson(request,audioRequestSchema);
    const bytes=await questionAudio(profile,input);
    return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'audio/mpeg','Content-Length':String(bytes.byteLength),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  } catch(error) {return api(async()=>{throw error;});}
}
