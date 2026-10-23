import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { approveUnit, hashContent, validateUnit } from './schema.mjs';
import { jsonResult } from './prompts.mjs';
import { scopePatchSchema, applyScopeEdits } from './reviewed-scope-content.mjs';
import { checkedPrefixWork, parsePrefixAuthor, parsePrefixEditor, prefixEditingSchema, PREFIX_AUTHOR_ID, PREFIX_EDITOR_ID } from './prefix-content.mjs';
import { prefixFiles, verifyPrefix } from './prefix.mjs';
import { boundedRequest, inspectPhaseOneGate } from './dispatcher.mjs';
import { assessSharedBudget } from './budget.mjs';
import { readJson, readOptionalJson, withExpansionLock, publishReviewedUnit } from './store.mjs';
import { scaleJson } from './scale-store.mjs';
import { sha256File, REPO_ROOT } from './activation.mjs';
const text=z.string().trim().min(1),sha=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/),unique=rows=>new Set(rows).size===rows.length;
export const prefixRecoveryProposalSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('offline-prefix-editorial-recovery'),id,prefixId:id,checkpoint:z.number().int().min(0).max(2),createdBy:text,createdAt:z.string().datetime(),configSha256:sha,manifestSha256:sha,ledgerSha256:sha,rows:z.array(z.object({unitId:id,editorRequestId:id,beforeContentSha256:sha,sourceAlternativeReasonIfNoneJa:z.string().min(20).max(700).nullable(),resolution:z.enum(['material-correction','review-adjudication']),reasonJa:text.max(2000),changes:z.array(scopePatchSchema).max(100),unit:z.unknown(),contentSha256:sha,reasonIfNoneJa:z.string().max(700)}).strict()).min(1).max(20)}).strict();
export const prefixRecoveryReviewSchema=z.object({schemaVersion:z.literal(1),proposalSha256:sha,reviewedBy:text,reviewedAt:z.string().datetime(),coverage:z.literal('every-complete-final-card'),verdicts:z.array(z.object({unitId:id,contentSha256:sha,approved:z.literal(true),issues:z.array(text).length(0)}).strict()).min(1).max(20)}).strict();
export const prefixRecoveryRootSchema=z.object({schemaVersion:z.literal(1),proposalSha256:sha,reviewSha256:sha,runtimeFilesSha256:sha,reviewedBy:z.literal('/root'),reviewedAt:z.string().datetime(),approved:z.literal(true),scaleAuthorized:z.literal(false)}).strict();
export function prefixRecoveryFiles(runtimeDirectory){return[...prefixFiles(runtimeDirectory),{id:'scripts/english-expansion/prefix-native-recovery.mjs',path:join(REPO_ROOT,'scripts/english-expansion/prefix-native-recovery.mjs')}];}
export const prefixRecoveryRuntimeHashes=runtimeDirectory=>Promise.all(prefixRecoveryFiles(runtimeDirectory).map(async f=>({id:f.id,sha256:await sha256File(f.path)})));
/** Reconstructs all valid paid edits. Only an explicitly reviewed missing alternative reason can be supplied. */
export function reconstructPrefixEditorUnit(work,message,unitId,sourceAlternativeReasonIfNoneJa=null){
 checkedPrefixWork(work);const before=work.units.find(u=>u.id===unitId),rows=jsonResult(message).edits;
 if(!before||!Array.isArray(rows)||!unique(rows.map(r=>r.unitId))||rows.some(r=>!work.unitIds.includes(r.unitId)))throw Error('Paid editor identity is ambiguous.');
 const edit=prefixEditingSchema.shape.edits.element.parse(rows.find(r=>r.unitId===unitId));if(edit.approved!==(edit.remainingIssues.length===0))throw Error('Paid editor verdict is inconsistent.');
 const{approved,remainingIssues,...patch}=structuredClone(edit),context=before.senses[0].tests.findIndex(t=>t.mode==='context'),alt=patch.patches.find(p=>p.path===`/senses/0/tests/${context}/alternatives`),alternatives=alt?.after??before.senses[0].tests[context].alternatives;
 if(sourceAlternativeReasonIfNoneJa!==null){if(alternatives.length||patch.reasonIfNoneJa!==''||sourceAlternativeReasonIfNoneJa.trim().length<20)throw Error('Only the exact missing alternative reason may be supplied.');patch.reasonIfNoneJa=sourceAlternativeReasonIfNoneJa;}
 if(alternatives.length&&patch.reasonIfNoneJa!=='')patch.reasonIfNoneJa='';
 const after=applyScopeEdits([before],[patch]);return{unit:after.units[0],reasonIfNoneJa:after.alternativeNotes[0].reasonIfNoneJa,originalEditorDecision:edit,sourceAlternativeReasonIfNoneJa};
}
/** Same constrained patch contract as the paid editor; no seed, IDs, provenance, relations or structure edits. */
export function applyPrefixRecoveryChanges(before,row){
 if(hashContent(before)!==row.beforeContentSha256)throw Error('Recovery before card changed.');
 const unit=applyScopeEdits([before],[{unitId:before.id,beforeContentSha256:hashContent(before),observationsJa:[row.reasonJa],patches:row.changes,reasonIfNoneJa:row.reasonIfNoneJa}]).units[0];
 if(hashContent(unit)!==row.contentSha256||hashContent(validateUnit(row.unit))!==row.contentSha256)throw Error('Final full card is not the exact documented revision.');
 if(row.resolution==='review-adjudication'?(row.changes.length||row.contentSha256!==row.beforeContentSha256):(!row.changes.length||row.contentSha256===row.beforeContentSha256))throw Error('Material correction and review adjudication must remain distinct.');return unit;
}
async function paidEvidence(output,config,ledger,requestId,checkpoint){
 id.parse(requestId);const call=ledger.calls.find(c=>c.id===requestId);if(!call||call.prefixId!==config.id||call.status!=='complete'||call.accountingHold)throw Error('Source paid request is not settled.');
 const root=`prefixes/${config.id}`,wave=`${root}/waves/${call.submissionId}`,workRecord=await readJson(join(output,'requests',requestId,'work.json')),request=await readJson(join(output,'requests',requestId,'request.json')),raw=await readJson(join(output,wave,'results',`${requestId}.json`)),outcome=await readJson(join(output,root,'outcomes',`${requestId}.json`)),plan=await readJson(join(output,wave,'plan.json')),complete=await readJson(join(output,wave,'complete.json'));
 const work=checkedPrefixWork(workRecord.work),planned=plan.requests.find(r=>r.id===requestId);
 if(work.id!==requestId||plan.configSha256!==hashContent(config)||plan.checkpoint!==checkpoint||!planned||planned.workSha256!==hashContent(work)||planned.requestHash!==call.requestHash||hashContent(planned.unitIds)!==hashContent(work.unitIds)||boundedRequest(request).requestHash!==call.requestHash||hashContent(request.params)!==hashContent(work.params)||hashContent(raw.result)!==call.responseHash||raw.providerBatchId!==call.providerBatchId||raw.result?.custom_id!==requestId||raw.result.result?.type!=='succeeded'||raw.result.result.message.model!==work.params.model||raw.result.result.message.stop_reason!=='end_turn'||complete.planSha256!==hashContent(plan)||!complete.resultHashes.some(r=>r.id===requestId&&r.sha256===call.responseHash)||outcome.responseSha256!==call.responseHash||outcome.rawSha256!==hashContent(raw))throw Error('Paid work, response, outcome and completed wave must bind exactly.');
 const parsed=work.operation==='author'?parsePrefixAuthor(raw.result.result.message,work):parsePrefixEditor(raw.result.result.message,work);
 if(hashContent(parsed)!==hashContent(outcome.result))throw Error('Saved parsed outcome differs from its unchanged paid raw.');
 return{call,workRecord,request,raw,outcome,plan,complete};
}
function approvals(proposal,review,root,runtimeHashes){
 if(!unique(proposal.rows.map(r=>r.unitId))||!unique(review.verdicts.map(r=>r.unitId))||review.verdicts.length!==proposal.rows.length||review.proposalSha256!==hashContent(proposal)||root.proposalSha256!==hashContent(proposal)||root.reviewSha256!==hashContent(review)||root.runtimeFilesSha256!==hashContent(runtimeHashes)||[proposal.createdBy,PREFIX_AUTHOR_ID,PREFIX_EDITOR_ID].includes(review.reviewedBy))throw Error('Exact independent full-card review, root approval and current recovery code are required.');
 for(const row of proposal.rows){const v=review.verdicts.find(v=>v.unitId===row.unitId);if(!v||v.contentSha256!==row.contentSha256||review.reviewedBy===row.unit.provenance?.author)throw Error('Independent review is not bound to every complete final card.');}
}
/** Offline only: no provider dependency, no writes to raw, costs, prefix outcomes or continuation decisions. */
export async function recoverPrefixNative(options,{write=false}={}){return withExpansionLock(options,async lease=>{
 const checked=await verifyPrefix(options),proposal=prefixRecoveryProposalSchema.parse(await readJson(options.proposalPath)),review=prefixRecoveryReviewSchema.parse(await readJson(options.reviewPath)),root=prefixRecoveryRootSchema.parse(await readJson(options.rootApprovalPath));
 const runtimeHashes=await prefixRecoveryRuntimeHashes(options.runtimeDirectory);approvals(proposal,review,root,runtimeHashes);
 await access(join(options.runtimeDirectory,'stop-prefix'));const c=checked.config,base=`prefixes/${c.id}/checkpoints/${proposal.checkpoint}`,manifest=await readJson(join(options.output,base,'manifest.json')),native=await readOptionalJson(join(options.output,base,'native-review.json'));
 if(proposal.prefixId!==c.id||proposal.configSha256!==checked.configSha256||proposal.manifestSha256!==hashContent(manifest)||manifest.configSha256!==checked.configSha256||manifest.checkpoint!==proposal.checkpoint||proposal.ledgerSha256!==hashContent(checked.ledger)||checked.ledger.calls.some(call=>call.status!=='complete'||call.accountingHold||!Number.isFinite(call.actualUsd)||call.actualUsd<0||call.actualUsd>call.reservedUsd)||(checked.ledger.commitments??[]).some(r=>r.status==='held'))throw Error('Recovery needs the exact stopped, settled checkpoint and retained budget.');
 if(await readOptionalJson(join(options.output,base,'continue.json')))throw Error('A released checkpoint cannot be recovered in place.');
 for(const row of manifest.paidRequests)if(hashContent(checked.ledger.calls.find(c=>c.id===row.id))!==row.sha256)throw Error('Checkpoint spending proof changed.');
 const gate=await inspectPhaseOneGate(lease,{...options,cashPurchases:checked.disabled.cashPurchases,historicalCommitments:checked.disabled.historicalCommitments,canonicalAudit:checked.disabled.canonicalAudit});if(!assessSharedBudget({...gate.snapshot,expansion:checked.ledger}).canCommitExpansion)throw Error('Shared stopped budget guard failed.');
 const cache=new Map(),get=async requestId=>{if(!cache.has(requestId))cache.set(requestId,await paidEvidence(options.output,c,checked.ledger,requestId,proposal.checkpoint));return cache.get(requestId);},rows=[];
 for(const row of proposal.rows){
  const editor=await get(row.editorRequestId);if(editor.workRecord.work.operation!=='editor')throw Error('Recovery must start from the latest paid editor.');const work=editor.workRecord.work,author=await get(work.sourceRequestId),original=author.outcome.result.units.find(u=>u.id===row.unitId),supplied=work.units.find(u=>u.id===row.unitId);
  if(author.workRecord.work.operation!=='author'||work.sourceRawSha256!==hashContent(author.raw)||!original||hashContent(original)!==hashContent(supplied)||!manifest.requests.some(r=>r.id===row.editorRequestId)||(!manifest.units.some(r=>r.unit.id===row.unitId)&&!manifest.held.some(r=>r.unitId===row.unitId)))throw Error('Latest full editor source is not the exact retained author card.');
  const registered=checked.seeds.find(s=>s.id===row.unitId);if(!registered||Object.keys(registered).some(k=>hashContent(registered[k])!==hashContent(original[k])))throw Error('Reviewed registered seed changed.');
  const source=reconstructPrefixEditorUnit(work,editor.raw.result.result.message,row.unitId,row.sourceAlternativeReasonIfNoneJa),unit=applyPrefixRecoveryChanges(source.unit,row),receipt={reviewer:review.reviewedBy,reviewedAt:review.reviewedAt,unitId:unit.id,contentSha256:row.contentSha256,approved:true,issues:[]};
  const provenance={method:'offline-prefix-independent-editorial-review',proposalSha256:hashContent(proposal),reviewSha256:hashContent(review),rootApprovalSha256:hashContent(root),manifestSha256:hashContent(manifest),configSha256:checked.configSha256,originalEditorDecision:source.originalEditorDecision,sourceAlternativeReasonIfNoneJa:row.sourceAlternativeReasonIfNoneJa,authorRequestId:author.call.id,authorRawSha256:hashContent(author.raw),editorRequestId:editor.call.id,editorRawSha256:hashContent(editor.raw),editorOutcomeSha256:hashContent(editor.outcome),sourceBeforeContentSha256:row.beforeContentSha256,finalContentSha256:row.contentSha256,changes:row.changes,resolution:row.resolution,reasonJa:row.reasonJa,reasonIfNoneJa:row.reasonIfNoneJa,nativeCheckpointReviewSha256:native?hashContent(native):null,paidCalls:0,scaleAuthorized:false,public:false,audio:false};
  rows.push({unit,receipt,approved:approveUnit(unit,receipt),provenance});
 }
 const directory=`prefixes/${c.id}/recoveries/${proposal.id}`,evidence=Object.fromEntries(cache),intent={schemaVersion:1,proposalSha256:hashContent(proposal),reviewSha256:hashContent(review),rootApprovalSha256:hashContent(root),evidenceSha256:hashContent(evidence),runtimeFilesSha256:hashContent(runtimeHashes),ledgerSha256:hashContent(checked.ledger),nativeCheckpointReviewSha256:native?hashContent(native):null,rows:rows.map(r=>({unitId:r.unit.id,contentSha256:hashContent(r.unit),approvedSha256:hashContent(r.approved),provenanceSha256:hashContent(r.provenance)})),paidCalls:0,scaleAuthorized:false,public:false,audio:false};
 const previous=await readOptionalJson(join(options.output,directory,'intent.json')),complete=await readOptionalJson(join(options.output,directory,'receipt.json'));if(previous&&hashContent(previous)!==hashContent(intent)||complete&&(!previous||hashContent(complete)!==hashContent({...intent,completed:true})))throw Error('Recovery replay has different immutable evidence.');
 for(const row of rows){const old=await readOptionalJson(join(options.output,'approved',`${row.unit.id}.json`));if(old&&(!previous||hashContent(old)!==hashContent(row.approved))||complete&&!old)throw Error('An existing approved revision must never be replaced or silently restored.');}
 if(write){if(hashContent(await readJson(join(options.output,'ledger.json')))!==proposal.ledgerSha256)throw Error('Spending changed before offline recovery.');await access(join(options.runtimeDirectory,'stop-prefix'));
  await scaleJson(lease,`${directory}/authority.json`,{proposal,review,rootApproval:root});await scaleJson(lease,`${directory}/source-evidence.json`,evidence);await scaleJson(lease,`${directory}/intent.json`,intent);
  for(const row of rows){await scaleJson(lease,`${directory}/provenance/${row.unit.id}.json`,row.provenance);await scaleJson(lease,`drafts/${row.unit.id}/${hashContent(row.unit)}.json`,{unit:row.unit,contentSha256:hashContent(row.unit)});await publishReviewedUnit(lease,row.unit,row.receipt,rows.flatMap(r=>r.unit.senses.map(s=>s.id)));}
  await scaleJson(lease,`${directory}/receipt.json`,{...intent,completed:true});
 }
 return{state:write?'recovered-private-only':'dry-run-native-prefix-recovery',units:rows.length,paidCalls:0,scaleAuthorized:false,public:false,audio:false,replayed:Boolean(previous),proposalSha256:hashContent(proposal)};
});}
