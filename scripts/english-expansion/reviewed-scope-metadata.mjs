import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { hashContent } from './schema.mjs';
import { jsonResult } from './prompts.mjs';
import { parseScopeAuthor, scopeGenerationSchema } from './reviewed-scope-content.mjs';
const sha=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/);
const redundantReason='代替語は位置づけている。';
export const scopeMetadataAmendmentSchema=z.object({schemaVersion:z.literal(1),kind:z.literal('reviewed-scope-existing-alternatives-note-normalization'),scopeId:id,authoritySha256:sha,reviewedBy:z.literal('/root'),reviewedAt:z.string().datetime(),approved:z.literal(true),addsPaidAuthority:z.literal(false),sourceRequestId:id,sourceRequestHash:sha,sourceWorkSha256:sha,sourceRawSha256:sha,sourceUnitsSha256:sha,settledAuthorLedgerSha256:sha,beforeNotesSha256:sha,afterNotesSha256:sha,unitIds:z.array(id).length(5),materializedUnitsSha256:sha,oldRuntimeFilesSha256:sha,newRuntimeFiles:z.array(z.object({id:z.string(),sha256:sha}).strict())}).strict();
/** Pure inspection of the one known redundant-metadata shape; never edits raw. */
export function previewScopeMetadataNormalization(raw,work){
 if(work.operation!=='author'||raw.requestId!==work.id||raw.requestHash===undefined)throw Error('The exact existing author raw/work is required.');
 const parsed=scopeGenerationSchema.parse(jsonResult(raw.response));
 if(parsed.units.length!==5||parsed.alternativeNotes.length!==5||new Set(parsed.alternativeNotes.map(n=>n.unitId)).size!==5||hashContent(parsed.units.map(u=>u.unitId))!==hashContent(work.unitIds)||hashContent(parsed.alternativeNotes.map(n=>n.unitId))!==hashContent(work.unitIds))throw Error('Exactly the five source units and ordered notes are required.');
 if(parsed.alternativeNotes.some(n=>n.reasonIfNoneJa!==redundantReason)||parsed.units.some(u=>!u.tests.find(t=>t.mode==='context')?.alternatives.length))throw Error('Only the known redundant reason on cards with existing alternatives can be normalized.');
 const afterNotes=parsed.alternativeNotes.map(n=>({...n,reasonIfNoneJa:''}));
 const payload={units:parsed.units,alternativeNotes:afterNotes};
 const result=parseScopeAuthor({...raw.response,content:[{type:'text',text:JSON.stringify(payload)}]},work);
 return{result,proof:{sourceRequestId:work.id,sourceRequestHash:raw.requestHash,sourceWorkSha256:hashContent(work),sourceRawSha256:hashContent(raw),sourceUnitsSha256:hashContent(parsed.units),beforeNotesSha256:hashContent(parsed.alternativeNotes),afterNotesSha256:hashContent(afterNotes),unitIds:work.unitIds,materializedUnitsSha256:hashContent(result.units)}};
}
export function parseScopedAuthorEvidence(raw,work,amendment){if(!amendment)return parseScopeAuthor(raw.response,work);const checked=scopeMetadataAmendmentSchema.parse(amendment),preview=previewScopeMetadataNormalization(raw,work);if(Object.keys(preview.proof).some(key=>hashContent(preview.proof[key])!==hashContent(checked[key])))throw Error('Metadata amendment is not bound to this exact source/content.');return preview.result;}
/** A root amendment only changes this main runtime file and adds this helper. */
export async function checkedScopeMetadataAmendment(path,authority,currentFiles){if(!path)return null;if(await realpath(path)!==resolve(path))throw Error('Metadata amendment path cannot alias.');const amendment=scopeMetadataAmendmentSchema.parse(JSON.parse(await readFile(path,'utf8')));
 if(amendment.scopeId!==authority.id||amendment.authoritySha256!==hashContent(authority)||amendment.sourceRequestId!==authority.author.id||amendment.sourceWorkSha256!==authority.author.workSha256||amendment.oldRuntimeFilesSha256!==hashContent(authority.files))throw Error('Metadata amendment changed the original authority.');
 const old=new Map(authority.files.map(f=>[f.id,f.sha256])),next=new Map(amendment.newRuntimeFiles.map(f=>[f.id,f.sha256]));
 const main='scripts/english-expansion/reviewed-scope.mjs',helper='scripts/english-expansion/reviewed-scope-metadata.mjs';
 if(old.size!==authority.files.length||next.size!==amendment.newRuntimeFiles.length||next.size!==old.size+1||old.has(helper)||!next.has(helper)||!old.has(main)||old.get(main)===next.get(main)||currentFiles.length!==next.size||currentFiles.some(f=>!next.has(f.id)))throw Error('Only the exact metadata helper/main runtime transition is permitted.');
 for(const [key,value]of old)if(key!==main&&next.get(key)!==value)throw Error('Metadata amendment cannot change any other bound file.');return amendment;
}
