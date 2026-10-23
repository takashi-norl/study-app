import type { LearningPlan } from './types';

export const PRACTICE_CATEGORIES: { subject: string; focusOptions: string[] }[] = [
  {subject:'英語',focusOptions:['おまかせ','単語・熟語','文法','読解','英検対策']},
  {subject:'古文',focusOptions:['おまかせ','古文単語','助動詞・文法','助詞','敬語','読解','徒然草の読解']},
  {subject:'漢文',focusOptions:['おまかせ','句法','重要語句','返り点・書き下し','読解']},
  {subject:'国語',focusOptions:['おまかせ','漢字・語彙','現代文読解','文学・評論','表現の理解']},
  {subject:'数学',focusOptions:['おまかせ','計算','関数','図形','確率・統計']},
  {subject:'社会',focusOptions:['おまかせ','日本史','世界史','地理','公民']},
  {subject:'理科',focusOptions:['おまかせ','物理','化学','生物','地学']},
];
export const QUESTION_COUNTS = [10,30,100,200,300] as const;
export const LEVEL_OPTIONS = ['おまかせ','基礎から','標準','少し難しく'] as const;
export const PURPOSE_OPTIONS = ['中間試験','期末試験','模試','英検','IELTS','日々の練習'] as const;
export const SCHEDULE_OPTIONS = ['あと1時間','1週間','1か月','長期','身につくまで'] as const;
export const DAILY_MINUTES = [5,10,20] as const;

export function questionVolumeLabel(count:number):string {
  if(!Number.isInteger(count) || count<1 || count>300) throw new Error('問題数は1〜300問で選んでください。');
  if(count<10) return `${count}問`;
  const rounds=Math.floor(count/10);
  const remainder=count%10;
  return `10問×${rounds}回分${remainder ? `＋${remainder}問` : ''}（計${count}問）`;
}

export interface QuickStartInput {
  subject:string;
  materialMode:'ai'|'sources';
  focus:string;
  difficulty:string;
  totalQuestions?:number;
  sourceIds:string[];
  purpose?:string;
  schedule?:string;
  minutesPerDay?:number;
  examTarget?:string;
  comment?:string;
  targetDate?:string;
}
export type QuickStartPlan = Pick<LearningPlan,'title'|'subject'|'goal'|'difficulty'|'targetDate'|'dailyQuestionTarget'|'sourceIds'> & {
  requestedQuestionCount?:number;
};

/** Turn tap selections into a saved plan and the first consultation, without requiring a title or free text. */
export function buildQuickStart(input:QuickStartInput):{plan:QuickStartPlan;message:string} {
  const subject=input.subject.trim();
  const focus=input.focus.trim() || 'おまかせ';
  const difficulty=input.difficulty.trim() || 'おまかせ';
  const purpose=input.purpose?.trim() || '日々の練習';
  const schedule=input.schedule?.trim() || '1か月';
  const minutesPerDay=input.minutesPerDay ?? 10;
  const examTarget=purpose==='英検' || purpose==='IELTS' ? input.examTarget?.trim() || '' : '';
  const comment=input.comment?.trim() || '';
  const targetDate=schedule==='身につくまで' ? undefined : input.targetDate?.trim() || undefined;
  if(!subject || subject.length>40) throw new Error('科目を選んでください。');
  if(focus.length>100 || difficulty.length>200 || purpose.length>40 || schedule.length>40 || examTarget.length>100 || comment.length>2000) throw new Error('コメントや選択内容を短くしてください。');
  if(!Number.isInteger(minutesPerDay) || minutesPerDay<1 || minutesPerDay>180) throw new Error('1日の学習時間を選んでください。');
  if(input.materialMode!=='ai' && input.materialMode!=='sources') throw new Error('問題のもとを選んでください。');
  const volume=input.totalQuestions === undefined ? undefined : questionVolumeLabel(input.totalQuestions);
  const sourceIds=input.materialMode==='sources' ? [...new Set(input.sourceIds)] : [];
  if(input.materialMode==='sources' && (input.sourceIds.length>20 || !sourceIds.length || sourceIds.some(id=>!id.trim()))) {
    throw new Error('教材ストックから1〜20件を選んでください。');
  }
  const purposeLabel=`${purpose}${examTarget ? ` ${examTarget}` : ''}`;
  const titleParts=[subject,purpose!=='日々の練習' ? purposeLabel : '',focus==='おまかせ' ? '' : focus].filter(Boolean);
  const title=(titleParts.length===1 ? `${subject}の練習` : titleParts.join('・')).slice(0,150);
  const sourceDescription=input.materialMode==='sources' ? '選んだ教材をもとに' : '一般的な学習内容から';
  const effectiveDifficulty=difficulty==='おまかせ' ? '進学校の高校1年を目安に調整' : difficulty;
  const timing=schedule==='あと1時間'
    ? '残り1時間で取り組む。要点と間違いやすい点を優先し、最初の10問から確認する。'
    : schedule==='身につくまで'
      ? `期限を決めず、身につくまで1日${minutesPerDay}分を目安に取り組む。初回の理解と別日の復習成績、誤答の減少を分けて確かめる。`
      : `${schedule}をかけて、1日${minutesPerDay}分を目安に取り組む。新しい問題と日を空けた復習を組み合わせる。`;
  const goal=`進学校の高校1年を目安に、${purposeLabel}に向けて練習する。${sourceDescription}、${subject}の${focus==='おまかせ' ? '理解を確認できる内容' : focus}を${effectiveDifficulty}で練習する。${timing}${volume ? `${volume}を用意し、1回10問を目安に取り組む。` : 'まず3問のサンプルで出し方と難しさを確かめる。作る総数はサンプルを見てから決める。'}${comment ? `\n追加の希望：${comment}` : ''}`;
  const plan:QuickStartPlan={title,subject,goal,difficulty:effectiveDifficulty,targetDate,
    dailyQuestionTarget:10,sourceIds,...(input.totalQuestions === undefined ? {} : {requestedQuestionCount:input.totalQuestions})};
  const message=[
    'この選択から、まずおすすめの問題作成案を提案してください。選んだ案で3問のサンプルを作り、出題方法と難しさを相談してから総数を決めます。',
    `学習者：進学校の高校1年を目安にする\n科目：${subject}\n目的：${purposeLabel}\n問題のもと：${input.materialMode==='sources' ? '選択した教材' : 'AIにおまかせ（資料なし）'}\n練習する内容：${focus}\n難しさ：${effectiveDifficulty}\n使える期間：${schedule}${schedule==='あと1時間' ? '' : `\n1日の目安：${minutesPerDay}分`}\n問題数：${volume ?? 'まず3問のサンプル。全体の分量はまだ決めない'}`,
    schedule==='あと1時間' ? '残り1時間の対策です。最も大切な要点と誤答しやすい点を優先して、まず10問を解き、間違いを確認する時間を確保する案にしてください。作る総数と今回解く数を区別し、大量の問題をすべてこの1時間で終えられるとは約束しないでください。'
      : schedule==='身につくまで' ? `締め切りは設定せず、内容が身につくことを目標にしてください。1日${minutesPerDay}分を目安に、初回の理解と別日の復習、誤答の減少を分けて確認できる到達基準を提案してください。一度の正解や同日の反復だけで「完全にマスター」と断定しないでください。${volume ? '選択した問題数は今回作る分です。' : '作る総数はサンプルを見てから決めます。'}結果を見て次の練習を相談する形にし、無制限の自動作問・自動実行を約束しないでください。`
        : `1日${minutesPerDay}分の中で新しい問題・解説の確認・日を空けた復習を配分してください。1か月なら週ごとの目安も示し、全体の問題を一度で解く前提にしないでください。`,
    'タイトルは内容から付けてください。選択済みの内容で提案し、名前や目標の入力を必須にしないでください。後からコメントで範囲・難しさ・問題数を調整できる案にしてください。',
    input.materialMode==='sources' ? '選んだ教材の範囲と読み取れた内容を使ってください。問題数に対して内容が足りなければ、その理由と作れる範囲を提案してください。' : '資料は使わず、一般的な学習内容から作ってください。',
    targetDate ? `目標の日付：${targetDate}` : '',
    comment ? '追加の希望は、保存した目標に記載しています。あわせて反映してください。' : '',
  ].filter(Boolean).join('\n\n');
  return {plan,message};
}
