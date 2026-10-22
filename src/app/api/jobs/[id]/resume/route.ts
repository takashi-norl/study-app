import { z } from 'zod';
import { start } from 'workflow/api';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { getFullState } from '@/server/google-store';
import { ApiError,requireGenerationEnabled } from '@/server/config';
import { generationWorkflow } from '@/workflows/generate';
export async function POST(request:Request,context:{params:Promise<{id:string}>}) { return api(async()=>{
  await requireProfile('parent');
  await readJson(request,z.object({}));
  const {id}=await context.params;
  z.string().uuid().parse(id);
  requireGenerationEnabled();
  const {data}=await getFullState();
  const job=data.jobs.find(j=>j.id===id);
  if(!job) throw new ApiError(404,'作問依頼が見つかりません。');
  if(!['queued','running'].includes(job.status)) throw new ApiError(409,'この作問依頼はすでに終了しています。');
  // A deterministic Workflow hook makes resuming an already-running job a no-op.
  await start(generationWorkflow,[job.id]);
  return {job};
},202); }
