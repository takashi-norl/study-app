import { requireProfile } from '@/server/auth';
import { loadState } from '@/server/data';
import { api } from '@/server/http';
export const dynamic = 'force-dynamic';
export async function GET() { return api(async()=>{ const {profile}=await requireProfile(); return {data:await loadState(profile),profile}; }); }
