#!/usr/bin/env node
import { readFile, readdir, mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashVocabularyEntry, GRADES, normalizeLemma } from './vocabulary-batch/schema.mjs';
import { preserveVocabularyAudio } from './vocabulary-catalog-export-lib.ts';

const args=process.argv.slice(2), source=args[0];
if(!source||!source.startsWith('/'))throw Error('Usage: node scripts/vocabulary-catalog-export.mjs /absolute/asset-folder [--write]');
const write=args.includes('--write'), repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const target=join(repo,'content','vocabulary-generated');
const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
const frozen=JSON.parse(await readFile(join(source,'frozen-100.json'),'utf8'));
if(hashVocabularyEntry(frozen)!==manifest.frozenSha256)throw Error('Frozen assets changed.');
const existing=new Set(frozen.map(x=>normalizeLemma(x.entry.word)));
const approved=new Map();
for(const grade of Object.keys(GRADES)){
 let files=[];try{files=await readdir(join(source,'approved',grade));}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const file of files.filter(f=>f.endsWith('.json')).sort()){
  const chunk=JSON.parse(await readFile(join(source,'approved',grade,file),'utf8'));
  for(const item of chunk.entries){
   const seed=manifest.words.find(x=>x.id===item.entry.id);
   if(!seed||seed.frozen||seed.grade!==grade||seed.status!=='approved'||seed.batchId!==chunk.batchId)continue;
   if(item.review.status!=='approved'||item.review.contentSha256!==hashVocabularyEntry(item.entry))throw Error('Review hash mismatch.');
   if(existing.has(normalizeLemma(item.entry.word))||approved.has(item.entry.id))throw Error('Duplicate approved entry.');
   approved.set(item.entry.id,item.entry);
  }
 }
}
const batches=[];
for(const grade of Object.keys(GRADES)){
 const words=manifest.words.filter(x=>x.grade===grade&&!x.frozen);
 for(let offset=0;offset<words.length;offset+=100){
  const entries=words.slice(offset,offset+100).flatMap(x=>approved.has(x.id)?[approved.get(x.id)]:[]);
  if(!entries.length)continue;
  const id=`${grade}-${String(offset/100+1).padStart(3,'0')}`, file=`${id}.json`;
  // Preserve already-imported audio only when the exact word script still matches.
  let old;try{old=JSON.parse(await readFile(join(target,file),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const audio=preserveVocabularyAudio(old?.entries??[],entries,old?.audio??[]);
  batches.push({summary:{id,level:GRADES[grade].label,title:`${GRADES[grade].label}・単語セット${offset/100+1}`,entryCount:entries.length,file},data:{schemaVersion:2,entries,audio}});
 }
}
if(write){
 await mkdir(target,{recursive:true});
 for(const batch of batches){const path=join(target,batch.summary.file);await writeFile(`${path}.tmp`,JSON.stringify(batch.data,null,2)+'\n');await rename(`${path}.tmp`,path);}
 const path=join(target,'index.json');await writeFile(`${path}.tmp`,JSON.stringify({schemaVersion:2,batches:batches.map(x=>x.summary)},null,2)+'\n');await rename(`${path}.tmp`,path);
}
console.log(JSON.stringify({mode:write?'exported':'dry-run',preserved:100,approvedNew:approved.size,batches:batches.length,target},null,2));
