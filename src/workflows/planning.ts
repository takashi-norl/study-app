import { createHook } from 'workflow';
import { analyzePlanningSource, beginPlanning, completePlanning, failPlanning } from './planning-steps';

export async function planningWorkflow(turnId:string) {
  'use workflow';
  using ownership=createHook({token:`study-planning:${turnId}`});
  if(await ownership.getConflict()) return;
  try {
    const input=await beginPlanning(turnId);
    if(input.done) return;
    for(const sourceId of input.sourceIds) await analyzePlanningSource(turnId,sourceId);
    await completePlanning(turnId);
  } catch(error) {
    await failPlanning(turnId,error instanceof Error ? error.message : 'AI相談を完了できませんでした。');
  }
}
