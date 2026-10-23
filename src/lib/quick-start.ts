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

export type QuickStartPreset = 'kobun-material';
export const KOBUN_QUESTION_STYLES = [
  {id:'vocabulary',label:'単語問題',description:'教材の単語を、基本の意味と文脈で確かめる。',instructions:'教材の見出し語を対象に、基本の意味と文脈での使い分けを四択で問います。活用は教材に記載がある場合だけ扱います。保存された古文単語の作問ルールを、試作から本作成まで適用してください。'},
  {id:'context',label:'文脈で意味を選ぶ',description:'本文の前後から、語句の意味を考える。',instructions:'対象の語句と必要な前後の本文を示し、この文脈に合う意味を四択で問います。単語の意味を暗記しているだけではなく、本文のどこから判断できるかを解説してください。'},
  {id:'grammar',label:'助動詞・助詞の働き',description:'活用・接続・意味を、本文で見分ける。',instructions:'対象の助動詞・助詞を明示し、活用形・接続・意味・働きのうち1問で問う点を絞ります。形だけでは決められない場合は必要な文脈を示し、正解の根拠となる語や接続を解説してください。'},
  {id:'honorifics',label:'敬語と主語',description:'誰の動作か、誰への敬意かを読み取る。',instructions:'敬語や省略された主語を問う場合は、登場人物と前後の関係が判断できる本文を示します。誰の動作か、誰に対する敬意かを区別し、本文から確定できない人物や関係を補わないでください。'},
  {id:'translation',label:'現代語訳・内容理解',description:'言葉のつながりや人物の行動を理解する。',instructions:'対象箇所を明示し、文脈に合う現代語訳または内容理解を四択で問います。訳の選択肢の粒度をそろえ、本文にない主語・理由・出来事を正解へ足さないでください。'},
] as const;
export type KobunQuestionStyle = typeof KOBUN_QUESTION_STYLES[number]['id'];

export function quickStartDefaults(preset?:QuickStartPreset,sourceIds:readonly string[]=[]):Pick<QuickStartInput,'subject'|'materialMode'|'focus'> {
  return {subject:preset==='kobun-material'?'古文':PRACTICE_CATEGORIES[0].subject,
    materialMode:preset==='kobun-material'||sourceIds.length?'sources':'ai',focus:'おまかせ'};
}

export function purposeOptionsForSubject(subject:string) {
  return PURPOSE_OPTIONS.filter(purpose=>subject==='英語'||purpose!=='英検'&&purpose!=='IELTS');
}

function kobunAuthoringInstructions(input:QuickStartInput):string {
  if(input.subject.trim()!=='古文') return '';
  const style=KOBUN_QUESTION_STYLES.find(item=>item.id===(input.kobunQuestionStyle??'context'));
  if(!style) throw new Error('古文の出題方法を選んでください。');
  return [
    `古文の出題方法：${style.label}。${style.instructions}`,
    input.materialMode==='sources'
      ? '選択した教材の読み取れた範囲だけから出題します。原文の表記と必要な前後関係を保ち、判読できない文字や欠けた本文を推測で補わないでください。根拠が不足する場合は作れる範囲と不足を伝え、3問を無理に埋めないでください。'
      : '資料なしのため、一般的な古文学習の知識と自作例文を使います。実在する作品の本文や出典を捏造しないでください。',
    `${style.id==='vocabulary' ? '基本の意味は見出し語から、文脈問題は必要な前後関係から、正解を一つに絞れる四択にします。' : '各問に答えるための本文と対象箇所を含め、文脈から正解を一つに絞れる四択にします。'}選択肢に必要な訳を除き、問題文で対象箇所の現代語訳・正解・解説を先に示さないでください。解説では正解の根拠を説明し、文脈問題では誤答のどこが本文に合わないかを簡潔に説明してください。`,
    input.materialMode==='sources'
      ? '作問の根拠に、教材名・確認できるページや段落・原文の該当箇所を示します。ページが不明なら作らず、不確かな読み取りや解答は具体的に記して要確認にしてください。'
      : '作問の根拠にAI作成・資料なしと記し、不確かな解答は具体的に記してください。',
    'この出題方法と品質条件を作成案の条件にも残し、後の本作成へ引き継いでください。',
  ].join('\n');
}

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
  kobunQuestionStyle?:KobunQuestionStyle;
}
export type QuickStartPlan = Pick<LearningPlan,'title'|'subject'|'goal'|'difficulty'|'targetDate'|'dailyQuestionTarget'|'sourceIds'> & {
  requestedQuestionCount?:number;
  questionTemplate?:'kobun-vocabulary';
};

/** Turn tap selections into a saved plan and the first consultation, without requiring a title or free text. */
export function buildQuickStart(input:QuickStartInput):{plan:QuickStartPlan;message:string} {
  const subject=input.subject.trim();
  const vocabulary=subject==='古文' && input.kobunQuestionStyle==='vocabulary';
  if(vocabulary && input.materialMode!=='sources') throw new Error('単語問題は自分の教材を使います。写真・PDFを選んでください。');
  const focus=vocabulary ? '古文単語' : input.focus.trim() || 'おまかせ';
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
  const authoringInstructions=kobunAuthoringInstructions(input);
  const goal=`進学校の高校1年を目安に、${purposeLabel}に向けて練習する。${sourceDescription}、${subject}の${focus==='おまかせ' ? '理解を確認できる内容' : focus}を${effectiveDifficulty}で練習する。${timing}${volume ? `${volume}を用意し、1回10問を目安に取り組む。` : 'まず3問のサンプルで出し方と難しさを確かめる。作る総数はサンプルを見てから決める。'}${authoringInstructions ? `\n${authoringInstructions}` : ''}${comment ? `\n追加の希望：${comment}` : ''}`;
  const plan:QuickStartPlan={title,subject,goal,difficulty:effectiveDifficulty,targetDate,
    dailyQuestionTarget:10,sourceIds,...(vocabulary ? {questionTemplate:'kobun-vocabulary' as const} : {}),...(input.totalQuestions === undefined ? {} : {requestedQuestionCount:input.totalQuestions})};
  const message=[
    'この選択から、まずおすすめの問題作成案を提案してください。選んだ案で3問のサンプルを作り、出題方法と難しさを相談してから総数を決めます。',
    `学習者：進学校の高校1年を目安にする\n科目：${subject}\n目的：${purposeLabel}\n問題のもと：${input.materialMode==='sources' ? '選択した教材' : 'AIにおまかせ（資料なし）'}\n練習する内容：${focus}\n難しさ：${effectiveDifficulty}\n使える期間：${schedule}${schedule==='あと1時間' ? '' : `\n1日の目安：${minutesPerDay}分`}\n問題数：${volume ?? 'まず3問のサンプル。全体の分量はまだ決めない'}`,
    schedule==='あと1時間' ? '残り1時間の対策です。最も大切な要点と誤答しやすい点を優先して、まず10問を解き、間違いを確認する時間を確保する案にしてください。作る総数と今回解く数を区別し、大量の問題をすべてこの1時間で終えられるとは約束しないでください。'
      : schedule==='身につくまで' ? `締め切りは設定せず、内容が身につくことを目標にしてください。1日${minutesPerDay}分を目安に、初回の理解と別日の復習、誤答の減少を分けて確認できる到達基準を提案してください。一度の正解や同日の反復だけで「完全にマスター」と断定しないでください。${volume ? '選択した問題数は今回作る分です。' : '作る総数はサンプルを見てから決めます。'}結果を見て次の練習を相談する形にし、無制限の自動作問・自動実行を約束しないでください。`
        : `1日${minutesPerDay}分の中で新しい問題・解説の確認・日を空けた復習を配分してください。1か月なら週ごとの目安も示し、全体の問題を一度で解く前提にしないでください。`,
    'タイトルは内容から付けてください。選択済みの内容で提案し、名前や目標の入力を必須にしないでください。後からコメントで範囲・難しさ・問題数を調整できる案にしてください。',
    input.materialMode==='sources' ? '選んだ教材の範囲と読み取れた内容を使ってください。問題数に対して内容が足りなければ、その理由と作れる範囲を提案してください。' : '資料は使わず、一般的な学習内容から作ってください。',
    authoringInstructions,
    targetDate ? `目標の日付：${targetDate}` : '',
    comment ? '追加の希望は、保存した目標に記載しています。あわせて反映してください。' : '',
  ].filter(Boolean).join('\n\n');
  if(goal.length>4000||message.length>4000) throw new Error('コメントや選択内容を短くしてください。');
  return {plan,message};
}
