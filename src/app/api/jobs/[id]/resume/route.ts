import { z } from 'zod';
import { start } from 'workflow/api';
import { requireProfile } from '@/server/auth';
import { api,readJson } from '@/server/http';
import { getFullState } from '@/server/google-store';
import { ApiError,requireGenerationEnabled } from '@/server/config';
import { generationWorkflow } from '@/workflows/generate';
import { assertGenerationAccess } from '@/server/proposal-selection';
export async function POST(request:Request,context:{params:Promise<{id:string}>}) { return api(async()=>{
  const {profile}=await requireProfile();
  await readJson(request,z.object({}));
  const {id}=await context.params;
  z.string().uuid().parse(id);
  requireGenerationEnabled();
  const {data}=await getFullState();
  const job=data.jobs.find(j=>j.id===id);
  if(!job || (job.planId && job.requestedBy!==profile.id) || (profile.role==='student' && (job.requestedBy!==profile.id || job.audienceUserId!==profile.id))) throw new ApiError(404,'作問依頼が見つかりません。');
  assertGenerationAccess(data,job);
  if(!['queued','running'].includes(job.status)) throw new ApiError(409,'この作問依頼はすでに終了しています。');
  // A deterministic Workflow hook makes resuming an already-running job a no-op.
  await start(generationWorkflow,[job.id]);
  return {job};
},202); }
