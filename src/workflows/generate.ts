import { analyzeSource,beginGeneration,failGeneration,finishGeneration,generateBatch,planBatches } from './generation-steps';
import { createHook } from 'workflow';

export async function generationWorkflow(jobId:string) {
  'use workflow';
  using ownership=createHook({token:`study-generation:${jobId}`});
  if(await ownership.getConflict()) return;
  try {
    const input=await beginGeneration(jobId);
    if(input.done) return;
    for(const sourceId of input.sourceIds) await analyzeSource(jobId,sourceId);
    // Bounded work: never keep making paid calls to force an unjustified target count.
    const plan=await planBatches(jobId);
    const maxBatches=plan.batchCount+2;
    for(let batch=0;batch<maxBatches;batch++) {
      const result=await generateBatch(jobId,batch,plan.batchCount);
      if(result.generatedCount>=input.targetCount) break;
    }
    await finishGeneration(jobId);
  } catch(error) {
    const message=error instanceof Error ? error.message : '作問処理を完了できませんでした。';
    await failGeneration(jobId,message);
  }
}
