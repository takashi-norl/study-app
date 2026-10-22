export interface TextSource { id:string;name:string;text:string }
export const GENERATION_BATCH_SIZE=10;

/** Allow Japanese passages and explanations without reserving a 20-question response every time. */
export function questionOutputTokenBudget(count:number) {
  if(!Number.isInteger(count)||count<1||count>GENERATION_BATCH_SIZE) throw new RangeError('Invalid generation batch size');
  return Math.max(6000,2000+count*1500);
}

/** Keep all pages eligible while bounding each Claude request. A long source keeps its original citation ID. */
export function groupSources(sources:TextSource[],budget=75000):TextSource[][] {
  const parts:TextSource[]=[];
  for(const source of sources) {
    for(let offset=0;offset<source.text.length;offset+=30000) parts.push({...source,
      name:source.text.length>30000 ? `${source.name}（続き ${Math.floor(offset/30000)+1}）` : source.name,
      text:source.text.slice(offset,offset+30000),
    });
  }
  const groups:TextSource[][]=[];
  let current:TextSource[]=[];
  for(const part of parts) {
    if(current.length && JSON.stringify([...current,part]).length>budget) { groups.push(current);current=[]; }
    current.push(part);
  }
  if(current.length) groups.push(current);
  return groups;
}

export function plannedBatchCount(targetCount:number,groupCount:number) {
  return Math.max(Math.ceil(targetCount/GENERATION_BATCH_SIZE),Math.min(groupCount,targetCount));
}

export function countForBatch(remaining:number,batch:number,totalBatches:number) {
  return Math.min(GENERATION_BATCH_SIZE,Math.max(1,Math.ceil(remaining/Math.max(1,totalBatches-batch))));
}

export function promptBudget(prompts:string[],budget=20000):string[] {
  const chosen:string[]=[];
  let length=0;
  for(const prompt of [...prompts].reverse()) {
    const text=prompt.slice(0,700);
    if(length+text.length>budget) break;
    chosen.push(text);length+=text.length;
  }
  return chosen;
}
