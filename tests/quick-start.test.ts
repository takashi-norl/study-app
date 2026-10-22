import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuickStart, questionVolumeLabel, type QuickStartInput } from '../src/lib/quick-start';

const base:QuickStartInput={subject:'古文',materialMode:'ai',focus:'助動詞・文法',difficulty:'標準',totalQuestions:100,sourceIds:[]};

test('tap choices create a complete plan and first request without free text, keeping total volume separate from session size',()=>{
  const result=buildQuickStart(base);
  assert.equal(result.plan.title,'古文・助動詞・文法');
  assert.equal(result.plan.requestedQuestionCount,100);
  assert.equal(result.plan.dailyQuestionTarget,10);
  assert.ok(result.plan.goal.length>0);
  assert.match(result.message,/10問×10回分（計100問）/);
  assert.match(result.message,/資料なし/);
  assert.ok(result.message.length<=4000);
});

test('switching to AI clears previously selected sources; custom material requires a bounded real selection',()=>{
  assert.deepEqual(buildQuickStart({...base,sourceIds:['previous-private-source']}).plan.sourceIds,[]);
  assert.throws(()=>buildQuickStart({...base,materialMode:'sources'}),/1〜20件/);
  assert.throws(()=>buildQuickStart({...base,materialMode:'sources',sourceIds:['']}),/1〜20件/);
  assert.throws(()=>buildQuickStart({...base,materialMode:'sources',sourceIds:Array.from({length:21},(_,i)=>`s-${i}`)}),/1〜20件/);
  const sources=buildQuickStart({...base,materialMode:'sources',sourceIds:['s1','s2','s1']});
  assert.deepEqual(sources.plan.sourceIds,['s1','s2']);
  assert.match(sources.message,/選んだ教材/);
});

test('comments persist with a saved plan and optional dates remain in consultation; uneven quantities stay precise',()=>{
  const result=buildQuickStart({...base,comment:'敬語も少し入れて',targetDate:'2026-12-01',totalQuestions:25});
  assert.match(result.plan.goal,/追加の希望：敬語も少し入れて/);
  assert.doesNotMatch(result.message,/敬語も少し入れて/);
  assert.match(result.message,/保存した目標に記載/);
  assert.equal(result.plan.targetDate,'2026-12-01');
  assert.equal(questionVolumeLabel(25),'10問×2回分＋5問（計25問）');
  assert.equal(questionVolumeLabel(7),'7問');
  for(const count of [0,301,10.5,NaN,Infinity]) assert.throws(()=>questionVolumeLabel(count));
});

test('one-hour midterm preparation keeps the selected material and puts the first ten questions before coverage',()=>{
  const result=buildQuickStart({...base,purpose:'中間試験',schedule:'あと1時間',materialMode:'sources',sourceIds:['midterm-page'],totalQuestions:30,difficulty:'おまかせ'});
  assert.equal(result.plan.title,'古文・中間試験・助動詞・文法');
  assert.deepEqual(result.plan.sourceIds,['midterm-page']);
  assert.equal(result.plan.requestedQuestionCount,30);
  assert.match(result.plan.goal,/中間試験/);
  assert.match(result.plan.goal,/残り1時間/);
  assert.match(result.plan.difficulty,/高校1年/);
  assert.match(result.message,/最初の10問|まず10問/);
  assert.match(result.message,/作る総数と今回解く数を区別/);
});

test('one-month Eiken preparation saves the exam level and daily time, with spaced review and no source reuse',()=>{
  const result=buildQuickStart({...base,subject:'英語',focus:'単語・熟語',purpose:'英検',examTarget:'準1級',schedule:'1か月',minutesPerDay:5,sourceIds:['stale-source']});
  assert.match(result.plan.title,/英検 準1級/);
  assert.match(result.plan.goal,/英検 準1級/);
  assert.match(result.plan.goal,/1か月/);
  assert.match(result.plan.goal,/1日5分/);
  assert.deepEqual(result.plan.sourceIds,[]);
  assert.match(result.message,/日を空けた復習/);
  assert.equal(result.plan.requestedQuestionCount,100);
  const switched=buildQuickStart({...base,purpose:'日々の練習',examTarget:'準1級'});
  assert.doesNotMatch(switched.message,/準1級/);
});

test('mastery mode keeps an open deadline and distinguishes current practice quantity from learning completion',()=>{
  for(const focus of ['助詞','徒然草の読解']) {
    const result=buildQuickStart({...base,focus,schedule:'身につくまで',minutesPerDay:20,targetDate:'2026-12-01'});
    assert.equal(result.plan.targetDate,undefined);
    assert.doesNotMatch(result.message,/2026-12-01|目標の日付/);
    assert.match(result.plan.goal,/期限を決めず/);
    assert.match(result.plan.goal,/1日20分/);
    assert.match(result.message,/別日の復習/);
    assert.match(result.message,/選択した問題数は今回作る分/);
    assert.equal(result.plan.requestedQuestionCount,100);
  }
});


test('a full optional comment remains saved even before any AI conversation, within both storage and request limits',()=>{
  const comment='希'.repeat(2000);
  const result=buildQuickStart({...base,comment,schedule:'身につくまで'});
  assert.ok(result.plan.goal.endsWith(comment));
  assert.ok(result.plan.goal.length<=4000);
  assert.ok(result.message.length<=4000);
});
