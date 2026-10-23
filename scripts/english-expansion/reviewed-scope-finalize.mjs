import { join } from 'node:path';
import { z } from 'zod';
import { approveUnit, hashContent, validateRelations } from './schema.mjs';
import { approvedSnapshot } from './cheap-benchmark.mjs';
import { scopeQuote } from './reviewed-scope-provider.mjs';
import { boundedRequest, inspectPhaseOneGate } from './dispatcher.mjs';
import { readJson, readOptionalJson, withExpansionLock, publishReviewedUnit } from './store.mjs';
import { checkedScopeWork, parseScopeEditor, SCOPE_AUTHOR_ID, SCOPE_EDITOR_ID } from './reviewed-scope-content.mjs';
import { verifyReviewedScope, verifyScopedLedger, verifyScopedEditorSource, immutableScopeEvidence } from './reviewed-scope.mjs';
const sha=z.string().regex(/^[a-f0-9]{64}$/), name=z.string().min(1).max(100);
export const scopeNativeReviewSchema=z.object({schemaVersion:z.literal(1),scopeId:name,authoritySha256:sha,editorResultSha256:sha,reviewedBy:name,reviewedAt:z.string().datetime(),coverage:z.literal('all-complete-reconstructed-after-cards'),verdicts:z.array(z.object({unitId:z.string(),contentSha256:sha,approved:z.literal(true),issues:z.array(z.string()).length(0)}).strict()).length(5)}).strict();
export const scopeFinalApprovalSchema=z.object({schemaVersion:z.literal(1),scopeId:name,authoritySha256:sha,editorResultSha256:sha,nativeReviewSha256:sha,ledgerSha256:sha,reviewedBy:z.literal('/root'),reviewedAt:z.string().datetime(),approved:z.literal(true),privateOnly:z.literal(true),scaleAuthorized:z.literal(false)}).strict();
/** No network path exists here. Immutable evidence precedes every private approval. */
export async function finalizeReviewedScope(options){return withExpansionLock(options,async lease=>{
 const native=scopeNativeReviewSchema.parse(await readJson(options.nativeReviewPath)),root=scopeFinalApprovalSchema.parse(await readJson(options.rootApprovalPath));
 const ids=native.verdicts.map(v=>v.unitId);if(new Set(ids).size!==5||[SCOPE_AUTHOR_ID,SCOPE_EDITOR_ID,'/root'].includes(native.reviewedBy))throw Error('A distinct native full-card reviewer is required.');
 const checked=await verifyReviewedScope(options,ids),{authority,seeds,config,state}=checked;
 if(native.scopeId!==authority.id||root.scopeId!==authority.id||native.authoritySha256!==checked.authoritySha256||root.authoritySha256!==checked.authoritySha256||root.nativeReviewSha256!==hashContent(native)||hashContent(ids)!==hashContent(seeds.map(s=>s.id)))throw Error('Final scope approval identities differ.');
 const ledger=await readJson(join(options.output,'ledger.json'));await verifyScopedLedger(options.output,ledger,authority);
 if(root.ledgerSha256!==hashContent(ledger)||ledger.calls.some(c=>c.status!=='complete'||c.accountingHold)||[authority.author.id,authority.editor.id].some(id=>!ledger.calls.some(c=>c.id===id)))throw Error('Final approval needs the exact settled author/editor ledger.');
 const gate=await inspectPhaseOneGate(lease,{phaseOneOutput:options.phaseOneOutput,runtimeDirectory:options.runtimeDirectory,cashPurchases:config.cashPurchases,historicalCommitments:config.historicalCommitments,canonicalAudit:config.canonicalAudit});if(gate.phaseOneFingerprint!==state.phaseOneFingerprint)throw Error('Frozen base changed.');
 const directory=join(options.output,'scopes',authority.id),registration=await readJson(join(directory,'registration.json'));
 const expectedRegistration={schemaVersion:1,scopeId:authority.id,authoritySha256:checked.authoritySha256,selectionSha256:authority.selectionSha256,seeds,legacyStoreSha256:authority.storeSha256};if(hashContent(registration)!==hashContent(expectedRegistration))throw Error('Finalization requires the exact registered scope.');
 const saved=await readJson(join(options.output,'requests',authority.editor.id,'work.json')),work=checkedScopeWork(saved.work),raw=await readJson(join(options.output,'requests',authority.editor.id,'response.json')),call=ledger.calls.find(c=>c.id===authority.editor.id);
 if(work.operation!=='editor'||work.id!==authority.editor.id||work.scopeId!==authority.id||hashContent(saved.quote.authority)!==checked.authoritySha256||raw.requestHash!==call.requestHash||boundedRequest({...work,reservedUsd:scopeQuote(work.params,'editor').reservedUsd}).requestHash!==call.requestHash)throw Error('Editor work does not match its saved authority.');
 await verifyScopedEditorSource(options.output,checked,work,ledger);const result=parseScopeEditor(raw.response,work),record=await readJson(join(directory,'editor-result.json'));
 const expected={scopeId:authority.id,requestId:work.id,requestHash:call.requestHash,rawSha256:hashContent(raw),workSha256:hashContent(work),result};if(hashContent(record)!==hashContent(expected)||native.editorResultSha256!==hashContent(record)||root.editorResultSha256!==hashContent(record))throw Error('Native review must bind the complete exact reconstructed editor result.');
 const rows=result.units.map(unit=>{const seed=seeds.find(s=>s.id===unit.id),v=native.verdicts.find(v=>v.unitId===unit.id);if(!seed||Object.keys(seed).some(k=>hashContent(seed[k])!==hashContent(unit[k]))||v.contentSha256!==hashContent(unit))throw Error('Final card differs from seed or native full review.');const receipt={reviewer:native.reviewedBy,reviewedAt:native.reviewedAt,unitId:unit.id,contentSha256:hashContent(unit),approved:true,issues:[]};return{unit,receipt,approved:approveUnit(unit,receipt)};});
 const existingSnapshot=await approvedSnapshot(options.output),existing=await Promise.all(existingSnapshot.filter(([filename])=>!ids.includes(filename.slice(0,-5))).map(([filename])=>readJson(join(options.output,'approved',filename))));
 const knownSenseIds=[...existing.flatMap(row=>row.unit.senses.map(s=>s.id)),...rows.flatMap(row=>row.unit.senses.map(s=>s.id))];validateRelations(rows.map(r=>r.unit),knownSenseIds);
 const intent={schemaVersion:1,scopeId:authority.id,authoritySha256:checked.authoritySha256,nativeReviewSha256:hashContent(native),rootApprovalSha256:hashContent(root),editorResultSha256:hashContent(record),ledgerSha256:hashContent(ledger),baselineApprovedSnapshotSha256:authority.approvedSnapshotSha256,units:rows.map(row=>({id:row.unit.id,contentSha256:hashContent(row.unit),approvedSha256:hashContent(row.approved)})),privateOnly:true,scaleAuthorized:false};
 const prior=await readOptionalJson(join(directory,'finalization-intent.json'));if(prior&&hashContent(prior)!==hashContent(intent))throw Error('Immutable finalization intent differs.');
 for(const row of rows){const approved=await readOptionalJson(join(options.output,'approved',`${row.unit.id}.json`));if(approved&&(!prior||hashContent(approved)!==hashContent(row.approved)))throw Error('An existing approved revision cannot be replaced.');const draft=await readJson(join(options.output,'drafts',row.unit.id,`${hashContent(row.unit)}.json`));if(hashContent(draft)!==hashContent({unit:row.unit,contentSha256:hashContent(row.unit)}))throw Error('Final card lacks its exact durable draft.');}
 if(!options.write)return{mode:'dry-run',privateUnits:5,paidCalls:0,publishedPublicly:0,scaleAuthorized:false};
 await immutableScopeEvidence(join(directory,'final-native-review.json'),native);await immutableScopeEvidence(join(directory,'final-root-approval.json'),root);
 await immutableScopeEvidence(join(directory,'finalization-intent.json'),intent);
 for(const row of rows)await publishReviewedUnit(lease,row.unit,row.receipt,knownSenseIds);
 if(hashContent(await readJson(join(options.output,'ledger.json')))!==root.ledgerSha256)throw Error('Ledger changed during private finalization.');await verifyReviewedScope(options,ids);
 const resultReceipt={...intent,status:'private-approved',nativeReviewer:native.reviewedBy,authorRequestId:authority.author.id,editorRequestId:authority.editor.id};await immutableScopeEvidence(join(directory,'finalization-result.json'),resultReceipt);
 return{mode:prior?'replayed':'applied',privateUnits:rows.length,paidCalls:0,publishedPublicly:0,scaleAuthorized:false,resultSha256:hashContent(resultReceipt)};
});}
