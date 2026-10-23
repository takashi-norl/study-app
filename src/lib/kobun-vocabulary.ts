import type { PlanningSample, QuestionTemplate } from './types';

/** Shared, version-controlled authoring rules; never copied from an AI proposal. */
export const KOBUN_VOCABULARY_RULES = `古文「単語問題」の作り方
範囲：本人が選んだ教材と指定範囲の、読めた見出し語・語義だけを使う。番号・印刷ページ・PDFページは区別し、実際に読めたものだけ記録する。欠けたページ、判読不可、曖昧な語義は補わず対象から外し、不足を返答で伝える。問題数や語番号を固定せず、指定数より根拠のある範囲を優先する。原本のないアレンジは渡された参考問題で確認できる語と語義だけを使い、原本を読んだとは言わない。
形式：各問は4択で、promptの先頭を【意味】【文脈】【活用】のいずれかにする。基本は意味を覚える問題と、文脈で意味を選ぶ問題。活用の区別は教材にその区別の説明が確認できる場合だけ。新しい語を先に一巡させてから別の聞き方を加え、既存の出題数を見て同じ語に偏らせない。少ない試作3問は全範囲を網羅したと表示しない。
問題文：【意味】は見出し語だけで意味を問える形にし、正解・現代語訳・語呂合わせ・解説を問題文に含めない。【文脈】は対象語を明示し、正解を確定できる前後関係を含める。傍線がない場合は「文中の『語』」と書く。原文引用は実際に読めた文だけを正確に使う。作った例文は必ず「学習用の自作例文」と問題文とsourceNoteに明記し、古文の語法と歴史的仮名遣いを保つ。実在作品名や出典を創作しない。
選択肢：A.、B.等のラベルを付けず、同じ品詞・粒度の意味を4個。重複・言い換え同義を避ける。文脈なしの意味問題ではその語の別の正しい語義を誤答に置かない。教材にないだけで誤りとは断定しない。文脈問題でも他の正しい語義が成立しない文脈を示す。正解は必ず一つ。正解を確定できない問題をneedsReviewで穴埋めせず、出力しない。
解説：100〜180字を目安に、正解の理由と覚え方の手がかりを平易に説明する。文脈問題では文中の根拠と紛らわしい誤答が合わない理由を短く示す。根拠のない語源・語呂合わせは作らず、教材の意味や対比を記憶の手がかりにする。現代語訳を添えるなら解説に置く。
整理：learningPointは必ず「古文単語｜見出し語」。番号・意味・問題形式を足さず、同じ語は教材の同じ見出し表記に統一する。sourceNoteには確認できた教材名・番号・ページと根拠の語義を短く書く。sourceIdsは実際に根拠がある今回の資料だけ。原本のないアレンジでは「元の問題を参考に」とし架空のページを付けない。
最終確認：範囲、基本問題の答え漏れ、原文と自作の区別、他の正しい語義を含めた解答一意性、根拠、表記、同語の重複を確かめる。選択肢の位置やA〜D・1〜4のラベルを問題文・解説で参照せず、選択肢の意味そのもので説明する。正解位置は偏らせず、語ごとの出題数と未出題語を確認してから返す。最新の希望で範囲・難しさ・配分を調整しても、読めない原本の補完や複数正解を認めない。`;

export function questionTemplateRules(subject: string, template?: QuestionTemplate): string | undefined {
  return subject === '古文' && template === 'kobun-vocabulary' ? KOBUN_VOCABULARY_RULES : undefined;
}

type VocabularyQuestion = Pick<PlanningSample, 'prompt'|'choices'|'correctIndex'|'explanation'|'learningPoint'|'sourceNote'> & { needsReview?: boolean };

/** Mechanical checks only; semantic accuracy still depends on evidence and human review. */
export function validateVocabularyQuestions<T extends VocabularyQuestion>(questions: T[]): T[] {
  return questions.map(question => {
    const point = question.learningPoint.match(/^古文単語[｜|：:]\s*(.{1,80})$/u);
    if (!point || !/^【(?:意味|文脈|活用)】/u.test(question.prompt) || question.needsReview
      || /傍線/u.test(question.prompt) || question.choices.length !== 4
      || !Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex > 3) {
      throw new Error('単語問題の形式や根拠を確認できません。教材の読める範囲を確認して、もう一度試作してください。');
    }
    const prose = `${question.prompt} ${question.explanation} ${question.choices.join(' ')}`;
    const label = '(?:[A-DＡ-Ｄ①-④アイウエ]|(?<![0-9０-９])[1-4１-４](?![0-9０-９つ個問字語文回日人年]))';
    const positionReference = new RegExp(`(?:選択肢|正解|答え)(?:の|は|が|：|:|\\s)*[「（(]?${label}|${label}(?:番(?:目)?)?(?:が|は|を|と|では|の選択肢)|(?:上|下|前|後)の選択肢`, 'u');
    if (positionReference.test(prose)) {
      throw new Error('選択肢の記号や位置を解説で参照せず、意味の内容で説明してください。');
    }
    const choices = question.choices.map(choice => choice.trim().replace(/^[A-DＡ-Ｄ][.．、:：)）]\s*/u, '').trim());
    const normalized = choices.map(choice => choice.normalize('NFKC').replace(/\s/g, ''));
    if (choices.some(choice => !choice) || new Set(normalized).size !== 4) {
      throw new Error('単語問題の選択肢が重複しています。もう一度試作してください。');
    }
    // A visible correct option in a basic recall prompt gives the answer away.
    if (question.prompt.startsWith('【意味】') && choices[question.correctIndex].length >= 2
      && question.prompt.normalize('NFKC').includes(choices[question.correctIndex].normalize('NFKC'))) {
      throw new Error('意味を問う問題文に正解が含まれています。答えを解説に移して試作してください。');
    }
    if (question.prompt.includes('自作例文') && !question.sourceNote.includes('自作例文')) {
      throw new Error('自作例文の根拠表示を確認できません。もう一度試作してください。');
    }
    return { ...question, choices, learningPoint: `古文単語｜${point[1].trim()}` };
  });
}

/** Reorder whole choices, preserving the accepted answer text and equalizing answer positions. */
export function balanceVocabularyChoices<T extends { choices: string[]; correctIndex: number; prompt?: string }>(questions: T[], prior: { correctIndex: number }[] = []): T[] {
  const counts = [0, 0, 0, 0];
  for (const question of prior) if (question.correctIndex >= 0 && question.correctIndex < 4) counts[question.correctIndex]++;
  return questions.map(question => {
    const targets = counts.flatMap((count, index) => count === Math.min(...counts) ? [index] : []);
    // A content-derived tie break avoids a repeating A/B/C/D answer pattern across batches.
    const seed = [...(question.prompt ?? question.choices.join('\u0000'))].reduce((hash, char) => (Math.imul(hash, 31) + char.codePointAt(0)!) >>> 0, 2166136261);
    const target = targets[seed % targets.length];
    const choices = [...question.choices];
    [choices[target], choices[question.correctIndex]] = [choices[question.correctIndex], choices[target]];
    counts[target]++;
    return { ...question, choices, correctIndex: target };
  });
}

export function vocabularyCoverage(questions: { learningPoint: string }[]) {
  const counts = new Map<string, number>();
  for (const question of questions) counts.set(question.learningPoint, (counts.get(question.learningPoint) ?? 0) + 1);
  return [...counts].map(([learningPoint, count]) => ({ learningPoint, count }));
}
