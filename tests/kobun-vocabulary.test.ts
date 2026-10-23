import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlanningSample } from '../src/lib/types';
import { balanceVocabularyChoices, questionTemplateRules, validateVocabularyQuestions, vocabularyCoverage } from '../src/lib/kobun-vocabulary';

const sample: PlanningSample = { prompt:'【意味】古文単語「まもる」の意味として適切なものを選びなさい。',
  choices:['じっと見つめる','声をかける','歩き回る','隠れて待つ'],correctIndex:0,
  explanation:'「まもる」は視線を向けてじっと見つめること。現代語の「守る」だけを思い浮かべず、目を離さず見る姿を手がかりに覚えよう。',
  learningPoint:'古文単語｜まもる',sourceIds:[],sourceNote:'教材の「まもる」の語義。',needsReview:false };

test('the vocabulary rules apply only to the explicitly selected classical-Japanese mode',()=>{
  assert.ok(questionTemplateRules('古文','kobun-vocabulary'));
  assert.equal(questionTemplateRules('古文'),undefined);
  assert.equal(questionTemplateRules('英語','kobun-vocabulary'),undefined);
});

test('normalization keeps one word grouping and preserves the answer while removing option labels',()=>{
  const original={...sample,learningPoint:'古文単語: まもる',choices:sample.choices.map((choice,i)=>`${'ＡＢＣＤ'[i]}．${choice}`)};
  const normalized=validateVocabularyQuestions([original])[0];
  assert.deepEqual(normalized.choices,sample.choices);
  assert.equal(normalized.learningPoint,sample.learningPoint);
  assert.equal(normalized.choices[normalized.correctIndex],sample.choices[0]);
  assert.ok(original.choices[0].startsWith('Ａ．'));
});

test('uncertain evidence, leaked basic answers, duplicate choices and unlabeled custom evidence are rejected',()=>{
  for(const patch of [
    {needsReview:true},
    {prompt:'【意味】「まもる」はじっと見つめるという意味です。その意味は？'},
    {choices:['A. 見る','B. 見る','C. 走る','D. 食べる']},
    {prompt:'【文脈】学習用の自作例文：子の顔をまもる。「まもる」の意味は？'},
    {prompt:'【文脈】傍線部「まもる」の意味は？'},
    {learningPoint:'まもるの基本意味'},
  ]) assert.throws(()=>validateVocabularyQuestions([{...sample,...patch}]));
  assert.doesNotThrow(()=>validateVocabularyQuestions([{...sample,prompt:'【文脈】学習用の自作例文：子の顔をまもる。「まもる」の意味は？',sourceNote:'教材の語義を使った学習用の自作例文。'}]));
});

test('position-dependent explanations are rejected before choices can be reordered',()=>{
  for(const explanation of ['正解はAです。','Bの選択肢は意味が違います。','選択肢1が正しい。','上の選択肢が正しい。','①が正解です。','正解は④です。','答えは「②」です。','1番が正解です。','３番目が適切です。','イが正解です。']) {
    assert.throws(()=>validateVocabularyQuestions([{...sample,explanation}]));
  }
});

test('ordinary quantity wording is not confused with a positional answer reference',()=>{
  for(const wording of ['正解は1つです。','正解は１つです。','正解は1個だけです。','２つの語義を確認しましょう。','No.51が今回の範囲です。']) {
    assert.doesNotThrow(()=>validateVocabularyQuestions([{...sample,prompt:`${sample.prompt}${wording}`,explanation:`${sample.explanation}${wording}`}]),wording);
  }
});

test('answer balancing spans batches, preserves content and does not mutate approved samples',()=>{
  const originals=Array.from({length:7},(_,i)=>({...sample,prompt:`${sample.prompt} (${i})`}));
  const before=JSON.stringify(originals);
  const first=balanceVocabularyChoices(originals.slice(0,3));
  const second=balanceVocabularyChoices(originals.slice(3),first);
  const all=[...first,...second];
  const counts=[0,1,2,3].map(index=>all.filter(q=>q.correctIndex===index).length);
  assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
  for(const question of all){assert.equal(question.choices[question.correctIndex],sample.choices[0]);assert.deepEqual([...question.choices].sort(),[...sample.choices].sort());}
  assert.equal(JSON.stringify(originals),before);
  assert.deepEqual(vocabularyCoverage([...all,{learningPoint:'古文単語｜めづ'}]),[{learningPoint:sample.learningPoint,count:7},{learningPoint:'古文単語｜めづ',count:1}]);
});
