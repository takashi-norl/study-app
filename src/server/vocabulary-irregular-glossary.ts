import 'server-only';
import type { GlossaryEntry } from '@/lib/vocabulary-glossary';
import { getVerbAliases, getVerbForms } from '@/lib/verb-forms';

// Original foundation entries. Their inflected forms link to the same dictionary entry.
const entries: [term: string, meaning: string, definition: string, text: string, translation: string][] = [
  [
    'take',
    '取る・持っていく／乗り物に乗る／時間がかかる（take notes はメモを取る）',
    'To pick up or carry something, travel using a vehicle, or need a particular amount of time. The meaning depends on the words around it.',
    'I have taken notes during every science lesson this month.',
    '今月は毎回の理科の授業でメモを取っています。',
  ],
  [
    'go',
    '行く・移動する',
    'To move or travel to another place.',
    'We went to the library after school to look for books about space.',
    '放課後、宇宙の本を探しに図書館へ行きました。',
  ],
  [
    'make',
    '作る・生み出す／〜を…の状態にする',
    'To create or produce something, or cause someone or something to be in a particular state.',
    'Our group made a simple model to explain how the bridge works.',
    '私たちの班は、橋の仕組みを説明するために簡単な模型を作りました。',
  ],
  [
    'write',
    '書く・文章を作る',
    'To put words on paper or a screen, or create a piece of text.',
    'She has written a short report about the plants near our school.',
    '彼女は学校の近くの植物について短い報告書を書きました。',
  ],
  [
    'read',
    '読む・文字から内容を理解する',
    'To look at written words and understand their meaning.',
    'I read the instructions twice yesterday before I started building the model.',
    '昨日、模型を作り始める前に説明書を二度読みました。',
  ],
  [
    'see',
    '見る・目に入る',
    'To notice something with your eyes.',
    'Have you seen the new poster beside the library entrance?',
    '図書館の入口の横にある新しいポスターを見ましたか。',
  ],
  [
    'give',
    '与える・渡す',
    'To pass something to another person for them to use or keep.',
    'The teacher gave each group a map before the outdoor activity.',
    '屋外活動の前に、先生は各班に地図を渡しました。',
  ],
  [
    'come',
    '来る（話し手や話題の中心に近づく）',
    'To move towards the speaker or the place being talked about.',
    'My cousins came to our house to help us prepare for the party.',
    'いとこたちは、パーティーの準備を手伝いに私たちの家へ来ました。',
  ],
  [
    'begin',
    '始める・始まる',
    'To start an activity, event, or period of time.',
    'The new term has begun, and we are choosing our club activities.',
    '新学期が始まり、私たちは部活動を選んでいます。',
  ],
  [
    'speak',
    '話す・言語を使って伝える',
    'To use your voice to communicate, or use a particular language.',
    'I spoke to a visitor in English during the school festival.',
    '文化祭で、私は来場者に英語で話しかけました。',
  ],
];

export const irregularGlossaryEntries: GlossaryEntry[] = entries.map(([term, meaning, definition, text, translation]) => ({
  id: `basic-${term}`,
  term,
  aliases: getVerbAliases(term),
  verbForms: getVerbForms(term)!,
  meaning,
  definition,
  level: '基礎の動詞',
  examples: [{ text, translation }],
  relatedIds: [],
}));
