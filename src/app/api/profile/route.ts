import { requireProfile } from '@/server/auth';
import { loadEvents } from '@/server/google-store';
import { api, readJson } from '@/server/http';
import { personalProfileState, savePersonalProfile } from '@/server/personal-profile';
import { personalProfileSaveSchema } from '@/server/personal-profile-schemas';

export async function GET() { return api(async()=>{
  const {profile}=await requireProfile();
  return personalProfileState(await loadEvents(),profile.id);
}); }

export async function PATCH(request:Request) { return api(async()=>{
  const {profile}=await requireProfile();
  return savePersonalProfile(profile,await readJson(request,personalProfileSaveSchema));
}); }
