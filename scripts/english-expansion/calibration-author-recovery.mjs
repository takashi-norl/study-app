import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { hashContent } from './schema.mjs';
import { sha256File } from './activation.mjs';
import { readJson } from './store.mjs';
import { scaleJson } from './scale-store.mjs';
import { boundedRequest } from './dispatcher.mjs';
import { scopeGenerationSchema } from './reviewed-scope-content.mjs';
import { jsonResult } from './prompts.mjs';
import { parseCalibrationAuthor } from './single-card-calibration-content.mjs';
const sha=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),file=z.object({id:z.string(),sha256:sha}).strict();
const MAIN='scripts/english-expansion/single-card-calibration.mjs',HELPER='scripts/english-expansion/calibration-author-recovery.mjs';
const rowSchema=z.object({requestId:id,unitId:z.string(),callSha256:sha,requestSha256:sha,workSha256:sha,rawSha256:sha,outcomeSha256:sha,returnedUnitId:z.string().nullable(),originalReasonIfNoneJa:z.string().nullable(),normalizedPayloadSha256:sha.nullable(),resultSha256:sha.nullable(),disposition:z.enum(['metadata-recovered-for-editor','truncated-held'])}).strict();
export const calibrationRecoverySchema=z.object({schemaVersion:z.literal(1),kind:z.literal('single-card-author-metadata-recovery'),id,prefixId:id,configSha256:sha,approved:z.literal(true),reviewedBy:z.literal('/root'),reviewedAt:z.string().datetime(),addsPaidAuthority:z.literal(false),learningContentChanged:z.literal(false),oldRuntimeFilesSha256:sha,newRuntimeFiles:z.array(file),source:z.object({planSha256:sha,completeSha256:sha,rows:z.array(rowSchema).length(6)}).strict()}).strict();
/** Only the two returned identity fields and redundant absence-reason metadata change. */
export function normalizeCalibrationAuthor(message,work){
 if(message.stop_reason!=='end_turn'||work.operation!=='author'||work.seeds?.length!==1)throw Error('Only a completed original single-card author response is recoverable.');
 const payload=scopeGenerationSchema.parse(jsonResult(message)),expected=work.seeds[0].id;
 if(payload.units.length!==1||payload.alternativeNotes.length!==1)throw Error('Exactly one original card and note are required.');
 const returned=payload.units[0].unitId,note=payload.alternativeNotes[0];
 if(!['-u1','-s1','-sense-1'].some(s=>returned===expected+s)||note.unitId!==returned)throw Error('Only a matching known identity suffix can be normalized.');
 const originalReasonIfNoneJa=note.reasonIfNoneJa,normalized=structuredClone(payload);
 normalized.units[0].unitId=expected;normalized.alternativeNotes[0].unitId=expected;
 if(normalized.units[0].tests.find(t=>t.mode==='context')?.alternatives.length)normalized.alternativeNotes[0].reasonIfNoneJa='';
 const result=parseCalibrationAuthor({...message,content:[{type:'text',text:JSON.stringify(normalized)}]},work);
 const restored=structuredClone(normalized);restored.units[0].unitId=returned;restored.alternativeNotes[0]={unitId:returned,reasonIfNoneJa:originalReasonIfNoneJa};
 if(hashContent(restored)!==hashContent(payload))throw Error('Recovery changed learning content.');
 return{payload:normalized,result,returnedUnitId:returned,originalReasonIfNoneJa};
}
async function sourceProof(options,config){
 if(config.maxUnits!==6)throw Error('This recovery is restricted to the six-card checkpoint.');
 const base=join(options.output,'prefixes',config.id),wave=`${config.id}-author-0`,dir=join(base,'waves',wave),plan=await readJson(join(dir,'plan.json')),complete=await readJson(join(dir,'complete.json')),ledger=await readJson(join(options.output,'ledger.json')),rows=[],recovered=[];
 if(plan.id!==wave||plan.configSha256!==hashContent(config)||plan.stage!=='generation'||plan.requests.length!==6||complete.planSha256!==hashContent(plan)||ledger.calls.some(c=>c.status!=='complete'&&c.prefixId!==config.id||c.accountingHold))throw Error('Saved completed author wave and settled historical accounting required.');
 for(let i=0;i<6;i++){
  const requestId=`${config.id}-a0-${i}`,r=plan.requests[i],call=ledger.calls.find(c=>c.id===requestId),request=await readJson(join(options.output,'requests',requestId,'request.json')),envelope=await readJson(join(options.output,'requests',requestId,'work.json')),raw=await readJson(join(dir,'results',`${requestId}.json`)),outcome=await readJson(join(base,'outcomes',`${requestId}.json`)),work=envelope.work,message=raw.result?.result?.message;
  if(r.id!==requestId||!call||call.status!=='complete'||call.accountingHold||call.prefixId!==config.id||call.submissionId!==wave||hashContent(raw.result)!==call.responseHash||r.requestHash!==call.requestHash||boundedRequest(request).requestHash!==call.requestHash||hashContent(work)!==r.workSha256||hashContent(work.params)!==hashContent(request.params)||work.unitIds.length!==1||hashContent(work.unitIds)!==hashContent(r.unitIds)||raw.result?.custom_id!==requestId||raw.result?.result?.type!=='succeeded'||message.model!==request.params.model||outcome.requestId!==requestId||outcome.responseSha256!==call.responseHash||outcome.rawSha256!==hashContent(raw)||outcome.result.units.length!==0||outcome.result.held.length!==1||outcome.result.held[0].unitId!==work.unitIds[0]||hashContent(outcome.result.held[0].issues)!==hashContent(['incomplete-or-ambiguous-result-no-retry']))throw Error('Original author evidence changed or was not the exact parser hold.');
  let normalized=null;if(i===0){if(message.stop_reason!=='max_tokens')throw Error('The first truncated card must stay held.');}else normalized=normalizeCalibrationAuthor(message,work);
  const row={requestId,unitId:work.unitIds[0],callSha256:hashContent(call),requestSha256:hashContent(request),workSha256:hashContent(envelope),rawSha256:hashContent(raw),outcomeSha256:hashContent(outcome),returnedUnitId:normalized?.returnedUnitId??null,originalReasonIfNoneJa:normalized?.originalReasonIfNoneJa??null,normalizedPayloadSha256:normalized?hashContent(normalized.payload):null,resultSha256:normalized?hashContent(normalized.result):null,disposition:normalized?'metadata-recovered-for-editor':'truncated-held'};rows.push(row);if(normalized)recovered.push({requestId,originalOutcome:outcome,...normalized});
 }
 if(hashContent(complete.resultHashes)!==hashContent(plan.requests.map(r=>({id:r.id,sha256:ledger.calls.find(c=>c.id===r.id).responseHash}))))throw Error('Completed wave result proof changed.');
 return{source:{planSha256:hashContent(plan),completeSha256:hashContent(complete),rows},recovered};
}
export async function checkedCalibrationRecovery(options,config,currentFiles){
 if(!options.amendmentPath)return null;
 if(await realpath(options.amendmentPath)!==resolve(options.amendmentPath))throw Error('Recovery authority cannot alias.');
 const amendment=calibrationRecoverySchema.parse(await readJson(options.amendmentPath)),old=new Map(config.files.map(f=>[f.id,f.sha256])),next=new Map(amendment.newRuntimeFiles.map(f=>[f.id,f.sha256]));
 if(amendment.prefixId!==config.id||amendment.configSha256!==hashContent(config)||amendment.oldRuntimeFilesSha256!==hashContent(config.files)||old.size!==config.files.length||next.size!==amendment.newRuntimeFiles.length||old.has(HELPER)||!next.has(HELPER)||next.size!==old.size+1||currentFiles.length!==next.size||currentFiles.some(f=>!next.has(f.id))||old.get(MAIN)===next.get(MAIN))throw Error('Exact original authority and one helper/main transition required.');
 for(const[k,v]of old)if(k!==MAIN&&next.get(k)!==v)throw Error('Recovery cannot change other bound runtime.');
 const proof=await sourceProof(options,config);if(hashContent(proof.source)!==hashContent(amendment.source))throw Error('Root-approved recovery source changed.');return{amendment,...proof};
}
export function recoveredCalibrationOutcome(checked,outcome){const source=checked.recovery?.recovered.find(r=>r.requestId===outcome.requestId);if(!source)return outcome;if(hashContent(source.originalOutcome)!==hashContent(outcome))throw Error('Recovered author outcome changed.');return{...outcome,result:source.result,authorRecovery:{amendmentSha256:hashContent(checked.recovery.amendment),originalOutcomeSha256:hashContent(outcome),normalizedPayloadSha256:hashContent(source.payload),learningContentChanged:false}};}
export async function persistCalibrationRecovery(lease,checked){if(!checked.recovery)return;const{amendment,recovered}=checked.recovery,base=`prefixes/${checked.config.id}/amendments/${amendment.id}`;await scaleJson(lease,`${base}/authority.json`,amendment);for(const r of recovered)await scaleJson(lease,`${base}/${r.requestId}.json`,{schemaVersion:1,amendmentSha256:hashContent(amendment),source:amendment.source.rows.find(s=>s.requestId===r.requestId),normalizedPayload:r.payload,result:r.result,qualityApproved:false});}
/** Pure file reads: root reviews/signs the draft; no requests, reservations or outcomes are changed. */
export async function prepareCalibrationRecovery(options,{id:amendmentId}){id.parse(amendmentId);const config=await readJson(options.configPath),{calibrationFiles}=await import('./single-card-calibration.mjs'),proof=await sourceProof(options,config);return{schemaVersion:1,kind:'single-card-author-metadata-recovery',id:amendmentId,prefixId:config.id,configSha256:hashContent(config),approved:false,reviewedBy:'/root',reviewedAt:new Date().toISOString(),addsPaidAuthority:false,learningContentChanged:false,oldRuntimeFilesSha256:hashContent(config.files),newRuntimeFiles:await Promise.all(calibrationFiles(options.runtimeDirectory).map(async f=>({id:f.id,sha256:await sha256File(f.path)}))),source:proof.source};}
