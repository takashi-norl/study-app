import { z } from 'zod';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { scopeAuthorWork, scopeEditorWork, scopeEditingSchema, parseScopeAuthor, applyScopeEdits, SCOPE_AUTHOR_POLICY, SCOPE_EDITOR_POLICY } from './reviewed-scope-content.mjs';
import { jsonResult } from './prompts.mjs';
import { hashContent, validateUnit } from './schema.mjs';
export const PREFIX_AUTHOR_ID = 'anthropic-prefix-haiku-author-v1';
export const PREFIX_EDITOR_ID = 'anthropic-prefix-sonnet-editor-v1';
const editRow = scopeEditingSchema.shape.edits.element.extend({ approved:z.boolean(), remainingIssues:z.array(z.string().trim().min(1)).max(20) }).strict();
export const prefixEditingSchema=z.object({edits:z.array(editRow).min(1).max(5)}).strict();
const authorInstruction='All four usage choices must be natural plausible English in a stated shared situation. Wrong choices should express a different intent, not absurd objects, invented word senses, malformed grammar or target-word salad. Feedback may explain only facts supplied in the question and ordinary lexical meaning, never infer unstated motives or relationships. '+
 'If a context alternative exists, reasonIfNoneJa must be the empty string. The parser may discard redundant exception prose only when alternatives exist; it never changes learning content. Do not invent external relation IDs.';
const editorInstruction='After applying your minimal patches mentally, independently judge the entire reconstructed final card: all meanings, every example/translation, all four questions, every distractor feedback, and exact-blank alternatives. Return approved=true and remainingIssues=[] only if no material defect remains; otherwise approved=false with concrete remainingIssues. Every requested unit needs a verdict. Do not approve on patch validity alone. Simple valid questions are acceptable. Never justify a choice by inventing context. Context alternatives must fit the unchanged exact blank, prepositions, objects and inflections; remove invalid ones and give a specific reason when none remains. A third independent reviewer samples complete final cards, including at least one per editor request, before private publication.';
export const PREFIX_CONTENT_POLICY={version:'affordable-prefix-v1',author:SCOPE_AUTHOR_POLICY,editor:{...SCOPE_EDITOR_POLICY,effort:'medium',thinking:{type:'adaptive'},maxTokens:12000},authorInstruction,editorInstruction,normalization:'discard-redundant-reason-only-when-alternatives-present',editingSchema:z.toJSONSchema(prefixEditingSchema,{target:'draft-7'})};
export const PREFIX_CONTENT_SHA256=hashContent(PREFIX_CONTENT_POLICY);
export function prefixAuthorWork(seeds,{id,scopeId,createdAt}) {
 const notes=seeds.map(seed=>({unitId:seed.id,senseJa:seed.pitfalls.map(p=>p.noteJa).join(' '),cautionsJa:seed.pitfalls.map(p=>p.noteJa)}));
 const work=scopeAuthorWork(seeds,notes,{id,scopeId,createdAt});work.promptVersion='affordable-prefix-v1';work.params.system+='\n'+authorInstruction;return work;
}
export function prefixEditorWork(source,options) {
 const work=scopeEditorWork(source,options);work.promptVersion='affordable-prefix-v1';
 work.params.system=work.params.system.replace('never output full cards or an approval claim.','never output full cards.').replace('An independent native reviewer will judge the reconstructed AFTER cards; your edits are not final approval.','The complete reconstructed AFTER cards require your independent quality verdict.');
 work.params.system+='\n'+editorInstruction;work.params.max_tokens=12000;work.params.thinking={type:'adaptive'};work.params.output_config.effort='medium';
 work.params.output_config.format=JSON.parse(JSON.stringify(jsonSchemaOutputFormat(z.toJSONSchema(prefixEditingSchema,{target:'draft-7'}))));return work;
}
export function checkedPrefixWork(work){const expected=work.operation==='author'?prefixAuthorWork(work.seeds,work):work.operation==='editor'?prefixEditorWork(work,work):null;if(!expected||hashContent(expected)!==hashContent(work))throw Error('Prefix work differs from reviewed policy.');return work;}
function selectedRows(payload,key,ids){if(!Array.isArray(payload?.[key])||payload[key].some(r=>!ids.includes(r.unitId))||new Set(payload[key].map(r=>r.unitId)).size!==payload[key].length)throw Error('Unknown or duplicate content identity.');return payload[key];}
/** Structural failures hold only the affected card; ambiguous identity fails the entire request. */
export function parsePrefixAuthor(response,work) {
 checkedPrefixWork(work);const payload=jsonResult(response),rows=selectedRows(payload,'units',work.unitIds),notes=selectedRows(payload,'alternativeNotes',work.unitIds),units=[],alternativeNotes=[],held=[],normalizations=[];
 for(const seed of work.seeds){try{const content=rows.find(r=>r.unitId===seed.id),note=structuredClone(notes.find(r=>r.unitId===seed.id));if(!content||!note)throw Error('Missing requested card.');
  const context=content.tests?.find(t=>t.mode==='context');if(context?.alternatives?.length&&typeof note.reasonIfNoneJa==='string'&&note.reasonIfNoneJa!==''){normalizations.push({unitId:seed.id,before:note.reasonIfNoneJa,after:''});note.reasonIfNoneJa='';}
  const original=scopeAuthorWork([seed],work.notes.filter(n=>n.unitId===seed.id),work),result=parseScopeAuthor({...response,content:[{type:'text',text:JSON.stringify({units:[content],alternativeNotes:[note]})}]},original);
  units.push(validateUnit({...result.units[0],provenance:{...result.units[0].provenance,author:PREFIX_AUTHOR_ID}}));alternativeNotes.push(note);
 }catch{held.push({unitId:seed.id,issues:['author-card-schema-or-alternative-contract']});}}
 return{units,alternativeNotes,held,normalizations};
}
export function parsePrefixEditor(response,work) {
 checkedPrefixWork(work);const rows=selectedRows(jsonResult(response),'edits',work.unitIds),units=[],alternativeNotes=[],held=[],decisions=[];
 for(const before of work.units){try{const edit=editRow.parse(rows.find(r=>r.unitId===before.id));if(edit.approved!==(edit.remainingIssues.length===0))throw Error('Inconsistent independent verdict.');const{approved,remainingIssues,...patch}=edit;
  // A redundant exception reason has the same declared normalization as the author.
  const context=before.senses[0].tests.findIndex(t=>t.mode==='context');const altPatch=patch.patches.find(p=>p.path===`/senses/0/tests/${context}/alternatives`);if((altPatch?.after??before.senses[0].tests[context].alternatives).length&&patch.reasonIfNoneJa!=='')patch.reasonIfNoneJa='';
  const after=applyScopeEdits([before],[patch]);decisions.push({unitId:before.id,beforeContentSha256:hashContent(before),contentSha256:hashContent(after.units[0]),approved,issues:remainingIssues,patches:patch.patches,observationsJa:patch.observationsJa});
  if(approved){units.push(after.units[0]);alternativeNotes.push(after.alternativeNotes[0]);}else held.push({unitId:before.id,issues:remainingIssues});
 }catch{held.push({unitId:before.id,issues:['editor-source-patch-or-verdict-contract']});}}
 return{units,alternativeNotes,held,decisions};
}
