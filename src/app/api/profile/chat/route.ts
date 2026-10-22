import { requireProfile } from '@/server/auth';
import { api, readJson } from '@/server/http';
import { chatPersonalProfile } from '@/server/personal-profile';
import { personalProfileChatSchema } from '@/server/personal-profile-schemas';

export const maxDuration=180;
export async function POST(request:Request) { return api(async()=>{
  const {profile}=await requireProfile();
  return chatPersonalProfile(profile,await readJson(request,personalProfileChatSchema));
}); }
