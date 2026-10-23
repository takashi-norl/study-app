import 'server-only';
import type { GlossaryEntry } from '@/lib/vocabulary-glossary';
import { vocabularyEntries } from './vocabulary-catalog';

// Original short explanations, not a copied dictionary or an official Eiken word list.
// Foundation entries are deliberately text-only; opening links never generates paid audio.
const foundation: [string, string[], string, string, string, string][] = [
  ['in order to', [], '〜するために（目的を表す）', 'Used before a verb to explain the purpose of an action.', 'We left early in order to catch the first bus.', '最初のバスに乗るために早く出発した。'],
  ['as well', [], '〜もまた', 'Also; in addition to something already mentioned.', 'I packed a notebook and a dictionary as well.', 'ノートを詰め、辞書も入れた。'],
  ['at least', [], '少なくとも', 'Not less than a particular amount or number.', 'Read at least one example before you answer.', '答える前に少なくとも例文を1つ読もう。'],
  ['at first', [], '初めは', 'At the beginning, before something changes.', 'At first I was worried, but the task became easier.', '初めは心配だったが、その課題はやりやすくなった。'],
  ['because of', [], '〜のために・〜が原因で（後ろは名詞など）', 'Used before a noun or noun phrase to give a reason.', 'The game was canceled because of the rain.', '雨のため試合は中止された。'],
  ['instead of', [], '〜の代わりに', 'Used to show that one thing replaces another.', 'I walked instead of taking the bus.', 'バスに乗る代わりに歩いた。'],
  ['such as', [], 'たとえば〜のような', 'Used to introduce examples.', 'Bring something to drink, such as water or tea.', '水やお茶など、何か飲み物を持ってきて。'],
  ['even though', [], '〜だけれども', 'Used when one fact makes another fact surprising.', 'She finished the task even though she was tired.', '疲れていたけれども、彼女は課題を終えた。'],
  ['as soon as', [], '〜するとすぐに', 'Immediately after something happens.', 'Call me as soon as you arrive at the station.', '駅に着いたらすぐに電話して。'],
  ['look for', ['looking for', 'looked for', 'looks for'], '〜を探す', 'Try to find someone or something.', 'We are looking for a quiet place to study.', '私たちは勉強する静かな場所を探している。'],
  ['take part in', ['takes part in', 'took part in', 'taking part in'], '〜に参加する', 'Join other people in an activity.', 'I want to take part in the school debate.', '学校の討論会に参加したい。'],
  ['be able to', ['is able to', 'are able to', 'was able to', 'were able to'], '〜できる', 'Have the skill, opportunity, or means to do something.', 'With this map, we will be able to find the shelter.', 'この地図があれば避難所を見つけられるだろう。'],
  ['focus on', ['focuses on', 'focused on', 'focusing on'], '〜に集中する', 'Give your attention to a particular thing.', 'Turn off your phone in order to focus on the task.', '課題に集中するために電話の電源を切ろう。'],
  ['be worried about', ['was worried about', 'were worried about', 'is worried about', 'are worried about'], '〜を心配している', 'Feel anxious because something bad might happen.', 'He was worried about making a mistake in the debate.', '彼は討論で間違えることを心配していた。'],
  ['make a mistake', ['making a mistake', 'made a mistake', 'makes a mistake'], '間違える', 'Do or say something that is not correct.', 'If you make a mistake, try again with a new example.', '間違えたら、新しい例でまた試してみよう。'],
  ['because', [], '〜なので（後ろは主語＋動詞）', 'Used before a clause to explain why something happens.', 'I took the bus because it was raining.', '雨が降っていたのでバスに乗った。'],
  ['although', [], '〜だけれども', 'Used to connect two facts that contrast with each other.', 'Although the path was long, we enjoyed the walk.', '道のりは長かったけれど、散歩を楽しんだ。'],
  ['while', [], '〜している間に・一方で', 'During the time that something happens; also used to contrast two facts.', 'I listened to the example while I walked home.', '帰り道を歩きながら例文を聞いた。'],
  ['until', [], '〜するまで（その状態・動作が続く）', 'Up to the time when something happens.', 'Wait here until the next bus arrives.', '次のバスが来るまでここで待って。'],
  ['beside', [], '〜のそばに', 'Next to someone or something.', 'There is a quiet path beside the river.', '川のそばに静かな小道がある。'],
  ['path', ['paths'], '小道・道筋', 'A narrow route for walking, or a way to reach a goal.', 'We followed the path in order to reach the river.', '川に着くためにその小道を進んだ。'],
  ['slippery', [], '滑りやすい', 'Easy to slide on, especially when wet.', 'The path becomes slippery because of the rain.', 'その小道は雨のせいで滑りやすくなる。'],
  ['task', ['tasks'], 'やるべき仕事・課題', 'A piece of work that needs to be done.', 'Finish one task before starting another.', '別の課題を始める前に1つ終えよう。'],
  ['label', ['labels', 'labeled', 'labelled', 'labeling', 'labelling'], 'ラベル・〜に名前などを付ける', 'A name or piece of information attached to something; to add that information.', 'Label each file so that your group can find it.', 'グループが見つけられるよう各ファイルに名前を付けよう。'],
  ['confusion', [], '混乱・区別や理解ができない状態', 'A state in which people are unsure what something means or what to do.', 'Clear labels help prevent confusion.', '分かりやすいラベルは混乱を防ぐ。'],
  ['combine', ['combines', 'combined', 'combining'], '組み合わせる・まとめる', 'Put things together to make one whole.', 'We combined our ideas in order to improve the plan.', '計画をよくするために考えをまとめた。'],
  ['shelter', ['shelters'], '避難所・雨風や危険を避けられる場所', 'A place that protects people or animals from danger or bad weather.', 'We looked for shelter because the rain was getting heavier.', '雨が強くなってきたので、雨を避けられる場所を探した。'],
  ['damage', ['damages', 'damaged', 'damaging'], '損傷・〜を傷つける', 'Harm that makes something less useful; to cause that harm.', 'Water can damage this notebook, so keep it dry.', '水でこのノートが傷むので、ぬらさずに保管して。'],
  ['raise', ['raises', 'raised', 'raising'], '〜を上げる・増やす', 'Move something higher or increase its amount.', 'The shop had to raise prices because of higher costs.', '費用が増えたため、その店は値上げしなければならなかった。'],
  ['remain', ['remains', 'remained', 'remaining'], '〜のままでいる・残る', 'Stay in the same state or continue to exist.', 'The gate remained closed until the driver arrived.', '運転手が着くまで門は閉まったままだった。'],
  ['trust', ['trusts', 'trusted', 'trusting'], '信頼・〜を信頼する', 'Belief that someone is honest or reliable; to have that belief.', 'Keeping promises helps build trust.', '約束を守ると信頼を築きやすくなる。'],
  ['claim', ['claims', 'claimed', 'claiming'], '主張・証拠が十分でないことも含めて〜と主張する', 'Say that something is true, although it may still need to be proved.', 'We need evidence before we accept that claim.', 'その主張を受け入れる前に証拠が必要だ。'],
  ['rumor', ['rumors', 'rumour', 'rumours'], 'うわさ', 'Information passed between people that has not been confirmed.', 'At first we believed the rumor, but it was not true.', '初めはうわさを信じたが、それは本当ではなかった。'],
  ['announcement', ['announcements'], 'お知らせ・発表', 'A public message that gives people information.', 'Read the announcement in order to check the meeting time.', '集合時刻を確認するためにお知らせを読もう。'],
  ['propose', ['proposes', 'proposed', 'proposing'], '〜を提案する', 'Suggest an idea or plan for people to consider.', 'She proposed a new way to organize our files.', '彼女はファイルを整理する新しい方法を提案した。'],
  ['so that', [], '〜するように・〜できるように', 'Used before a clause to explain an intended result or purpose.', 'Speak clearly so that everyone can understand the announcement.', '全員がお知らせを理解できるようにはっきり話そう。'],
];

// The 50 verbs in this fixed catalogue are regular; admit doubles its final consonant.
// Keep inflections attached to the same history entry instead of creating separate weak words.
function verbForms(word: string): string[] {
  const third = /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : /(?:s|sh|ch|x|z|o)$/.test(word) ? `${word}es` : `${word}s`;
  const past = word === 'admit' ? 'admitted' : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ied` : word.endsWith('e') ? `${word}d` : `${word}ed`;
  const ing = word === 'admit' ? 'admitting' : word.endsWith('e') ? `${word.slice(0, -1)}ing` : `${word}ing`;
  return [third, past, ing];
}

export const glossaryEntries: GlossaryEntry[] = [
  ...vocabularyEntries.map(entry => ({ id: entry.id, term: entry.word, aliases: entry.partOfSpeech === '動詞' ? verbForms(entry.word) : [], meaning: entry.meaning,
    definition: entry.definition, level: `${entry.level}を目安`, examples: entry.examples.map(({ text, translation }) => ({ text, translation })), relatedIds: [] })),
  ...foundation.map(([term, aliases, meaning, definition, text, translation]) => ({
    id: `basic-${term.replaceAll(' ', '-')}`, term, aliases, meaning, definition, level: '基礎の単語・表現',
    examples: [{ text, translation }], relatedIds: [],
  })),
];
