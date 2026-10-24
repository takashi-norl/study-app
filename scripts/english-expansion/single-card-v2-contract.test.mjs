import assert from 'node:assert/strict';
import test from 'node:test';
import { hashContent, validateUnit } from './schema.mjs';
import { seed, response } from './test-fixtures.mjs';
import { CALIBRATION_CONTENT_POLICY } from './single-card-calibration-content.mjs';
import { singleCardV2AuthorWork, singleCardV2EditorWork, parseSingleCardV2Author, parseSingleCardV2Editor,
  checkedSingleCardV2Work, SINGLE_CARD_V2_CONTENT_POLICY } from './single-card-v2-contract.mjs';
const date='2026-10-24T00:00:00.000Z';
const choice=(text,meaningJa,feedbackJa)=>({text,meaningJa,feedbackJa});
const choices=[choice('ready','準備ができている','準備の状態で、気が進まないこと自体は表しません。'),choice('eager','熱心にしたがる','強い意欲を表し、指定された意欲の低さと反対です。'),choice('reluctant','気が進まない','できるものの、やりたくない気持ちを表します。'),choice('able','能力がある','能力を表し、意欲の低さは表しません。')];
function payload(){return{card:{partOfSpeech:'adjective',meaningEn:'Not wanting to do something.',meaningJa:'何かをすることに気が進まない',examples:[
 {text:'I was reluctant to interrupt her while she was studying.',meaningJa:'彼女が勉強している間、声をかけて邪魔するのは気が進まなかった。',contextJa:'勉強中の人への声かけ'},
 {text:'The team was reluctant to change a plan that had worked well.',meaningJa:'チームは、うまくいっていた計画を変えることに気が進まなかった。',contextJa:'計画を変えるかどうか'},
 {text:'He gave a reluctant smile and agreed to join the game.',meaningJa:'彼は気乗りしない様子で笑みを浮かべ、ゲームに参加することに同意した。',contextJa:'気が進まない参加への同意'}],tests:{
 meaning:{prompt:'reluctant が表す気持ちとして合うものは？',choices:[choice('何かをすることに気が進まない','何かをすることに気が進まない','行動への意欲が低いことを表します。'),choice('何かをすることに強い関心がある','何かをすることに強い関心がある','強い関心は、気が進まないこととは異なります。'),choice('何かを上手にできる','何かを上手にできる','能力と意欲は別です。'),choice('何かをする準備が既に整っている','何かをする準備が既に整っている','準備の状態は、意欲の低さを表しません。')],correctIndex:0,explanationJa:'reluctant は能力ではなく、しようという気持ちが弱いことを表します。'},
 word:{prompt:'「できるが、気が進まない」という意味に合う英単語を選んでください。',choices:structuredClone(choices),correctIndex:2,explanationJa:'reluctant は、やろうという気持ちが進まない状態です。'},
 context:{prompt:'Nora said she did not want to give the speech, although she could do it. Which word expresses her lack of willingness? Nora was ___ to speak.',choices:structuredClone(choices),correctIndex:2,explanationJa:'話す能力がないのではなく、話す気が進まないことを問うています。',alternatives:[{text:'unwilling',meaningJa:'したがらない',noteJa:'同じ空所に入りますが、reluctant よりはっきりした拒否の気持ちを表すことがあります。'}]},
 usage:{prompt:'Your class needs a volunteer to give a talk. Which reply shows that you agree even though you would prefer not to do it?',choices:[choice("I'd love to give the talk. I already have a few ideas.",'ぜひ話したいです。もう少し案があります。','進んで引き受けたい気持ちを示しています。'),choice('How long should the talk be?','どのくらいの長さの話ですか。','長さの確認で、気が進まないという返答ではありません。'),choice('I have an exam then and cannot attend.','その時間は試験があり、出席できません。','予定が合わないという説明で、気が進まないとは限りません。'),choice("I'd rather not give the talk, but I will if nobody else can.",'できれば話したくありませんが、他にできる人がいなければやります。','気が進まないものの、引き受けることを表しています。')],correctIndex:3,explanationJa:'やりたいわけではないと述べながら、引き受ける条件を示す返答です。'}
}},reasonIfNoContextAlternativeJa:''};}
const author=()=>singleCardV2AuthorWork([seed('reluctant')],{id:'new-author',scopeId:'new-scope',createdAt:date});
const source=()=>parseSingleCardV2Author(response(payload()),author());
const editor=()=>singleCardV2EditorWork(source(),{id:'new-editor',scopeId:'new-scope',createdAt:date,sourceRequestId:'new-author',sourceRawSha256:hashContent('saved-exact-provider-raw')});
const verdict=()=>({observationsJa:['全文を確認しました。'],patches:[],reasonIfNoContextAlternativeJa:'',approved:true,remainingIssues:[]});
function checkRefs(schema){const walk=value=>{if(!value||typeof value!=='object')return;if(value.$ref){assert.ok(value.$ref.startsWith('#/'));let target=schema;for(const key of value.$ref.slice(2).split('/'))target=target?.[key];assert.ok(target,'every internal ref resolves');}for(const child of Object.values(value))walk(child);};walk(schema);}

test('wire is one card with four fixed modes and no generated identity; internal refs resolve',()=>{
 const work=author(),schema=work.params.output_config.format.schema;
 assert.deepEqual(schema.required,['card','reasonIfNoContextAlternativeJa']);
 assert.deepEqual(schema.properties.card.properties.tests.required,['meaning','word','context','usage']);
 assert.ok(!schema.properties.card.properties.unitId);assert.ok(!schema.properties.units);
 checkRefs(schema);checkRefs(editor().params.output_config.format.schema);
 assert.ok(JSON.stringify(work.params.output_config.format).length<3500);
 assert.ok(SINGLE_CARD_V2_CONTENT_POLICY.editorPrompt.length<CALIBRATION_CONTENT_POLICY.editor.length);
 assert.equal(work.params.max_tokens,4000);assert.deepEqual(work.params.thinking,{type:'disabled'});
});
test('original complete card maps into existing units, meanings, three examples and exact source-derived IDs',()=>{
 const p=payload(),before=hashContent(p),result=parseSingleCardV2Author(response(p),author()),u=result.units[0];
 assert.equal(hashContent(p),before);assert.equal(validateUnit(u).id,seed('reluctant').id);assert.equal(u.senses.length,1);assert.equal(u.senses[0].examples.length,3);
 assert.deepEqual(u.senses[0].tests.map(t=>t.mode),['meaning','word','context','usage']);
 assert.ok(u.senses[0].tests.every(t=>t.choices.length===4&&t.choices.every(c=>c.meaningJa&&c.feedbackJa)));
 assert.equal(u.senses[0].tests[2].alternatives[0].text,'unwilling');assert.deepEqual(u.senses[0].relations,[]);
 assert.ok(u.senses[0].examples.every(e=>e.id.startsWith(u.id+':core:example-')));assert.deepEqual(result.held,[]);
 assert.deepEqual(editor().units,[u]);
});
test('extra cards, model IDs, extra modes, missing translations and truncated JSON cannot pass',()=>{
 for(const change of[p=>p.units=[p.card],p=>p.card.unitId='invented-sense',p=>p.card.tests.grammar=p.card.tests.meaning,p=>delete p.card.tests.word.choices[0].meaningJa]){const p=payload();change(p);assert.throws(()=>parseSingleCardV2Author(response(p),author()));}
 assert.throws(()=>parseSingleCardV2Author({...response(payload()),stop_reason:'max_tokens'},author()),/did not complete/);
 assert.throws(()=>singleCardV2AuthorWork([seed('reluctant'),seed('able')],author()),/Exactly one/);
});
test('unused absence metadata is safely derived; no alternatives still requires a substantive reason',()=>{
 const p=payload();p.reasonIfNoContextAlternativeJa='代替表現も説明してあります。';const r=parseSingleCardV2Author(response(p),author());assert.equal(r.alternativeNotes[0].reasonIfNoneJa,'');assert.equal(r.normalizations[0].before,p.reasonIfNoContextAlternativeJa);assert.deepEqual(r.units[0].senses[0].tests[2].alternatives,p.card.tests.context.alternatives);
 p.card.tests.context.alternatives=[];p.reasonIfNoContextAlternativeJa='';assert.throws(()=>parseSingleCardV2Author(response(p),author()),/specific/);
 p.reasonIfNoContextAlternativeJa='この文の意図と同じ意味を保つ適切な言い換えがありません。';assert.equal(parseSingleCardV2Author(response(p),author()).units.length,1);
});
test('editor patches exact saved content and explicitly judges the full reconstructed card without model IDs',()=>{
 const work=editor(),before=hashContent(work.units),v=verdict(),old=work.units[0].senses[0].tests[1].explanationJa;
 v.patches=[{path:'/senses/0/tests/1/explanationJa',before:old,after:'reluctant は気が進まないという意味で、能力がないという意味ではありません。'}];
 const result=parseSingleCardV2Editor(response(v),work);assert.equal(result.units.length,1);assert.equal(hashContent(work.units),before);assert.equal(result.decisions[0].beforeContentSha256,hashContent(work.units[0]));assert.equal(result.decisions[0].contentSha256,hashContent(result.units[0]));assert.deepEqual(result.units[0].senses[0].examples,work.units[0].senses[0].examples);
 const held=parseSingleCardV2Editor(response({...verdict(),approved:false,remainingIssues:['文脈の修正が必要です。']}),work);assert.equal(held.units.length,0);assert.equal(held.held[0].unitId,work.unitIds[0]);
});
test('editor cannot approve inconsistent verdict, stale patch, seed/ID mutation or version-swapped work',()=>{
 const w=editor(),v=verdict();assert.throws(()=>parseSingleCardV2Editor(response({...v,remainingIssues:['問題が残っています。']}),w),/disagree/);
 assert.throws(()=>parseSingleCardV2Editor(response({...v,patches:[{path:'/senses/0/meaningJa',before:'not the source',after:'変更後'}]}),w),/before/);
 assert.throws(()=>parseSingleCardV2Editor(response({...v,patches:[{path:'/lemma',before:'reluctant',after:'eager'}]}),w));
 assert.throws(()=>parseSingleCardV2Editor(response({...v,unitId:'another'}),w));
 assert.throws(()=>checkedSingleCardV2Work({...author(),promptVersion:'single-card-calibration-v2'}),/exact version/);
});

test('fixable author language issues reach the editor but cannot be approved without Japanese meaning choices and true alternatives',()=>{
 const p=payload();p.card.tests.meaning.choices[0].text='Not wanting to do something';p.card.tests.context.alternatives=[{text:'reluctant',meaningJa:'気が進まない',noteJa:'同じ表現です。'}];
 const draft=parseSingleCardV2Author(response(p),author()),work=singleCardV2EditorWork(draft,{id:'repair-editor',scopeId:'new-scope',createdAt:date,sourceRequestId:'new-author',sourceRawSha256:hashContent('saved-raw')});
 assert.throws(()=>parseSingleCardV2Editor(response(verdict()),work),/Japanese meanings/);
 assert.equal(parseSingleCardV2Editor(response({...verdict(),approved:false,remainingIssues:['日本語の選択肢と別解の修正が必要です。']}),work).held.length,1);
 const v=verdict();v.patches=[{path:'/senses/0/tests/0/choices/0/text',before:'Not wanting to do something',after:'何かをすることに気が進まない'}];
 assert.throws(()=>parseSingleCardV2Editor(response(v),work),/cannot repeat/);
 v.patches.push({path:'/senses/0/tests/2/alternatives',before:p.card.tests.context.alternatives,after:payload().card.tests.context.alternatives});
 assert.equal(parseSingleCardV2Editor(response(v),work).units.length,1);
});
