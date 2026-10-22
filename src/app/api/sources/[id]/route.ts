import { requireProfile } from '@/server/auth';
import { downloadSourceFile,getFullState } from '@/server/google-store';
import { ApiError } from '@/server/config';
import { api } from '@/server/http';
export const maxDuration=300;
export async function GET(_request:Request,context:{params:Promise<{id:string}>}) {
  try {
    await requireProfile('parent');
    const {id}=await context.params;
    const source=(await getFullState()).data.sources.find(s=>s.id===id);
    if(!source?.storagePath) throw new ApiError(404,'資料が見つかりません。');
    const file=await downloadSourceFile(source.storagePath);
    return new Response(Buffer.from(file.bytes),{headers:{'Content-Type':file.mimeType,'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(source.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Content-Security-Policy':"frame-ancestors 'self'"}});
  } catch(error) { return api(async()=>{throw error;}); }
}
