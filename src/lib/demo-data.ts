import type { Attempt, Exposure, PracticeSession, Question, StudyData, Subject, Topic } from './types';
import { formatJapanDate } from './learning';

type Example = [prompt: string, answer: string, distractors: [string, string, string], explanation: string, point: string];

const KOBUN: Example[] = [
  ['古語「いと」の意味として適切なものは？', 'とても', ['少しも〜ない', '突然', 'やがて'], '「いと」は程度がはなはだしいことを表す副詞で、「とても」「たいそう」と訳します。', '程度を表す副詞'],
  ['古語「ありがたし」のもとの意味として適切なものは？', 'めったにない', ['感謝したい', '腹立たしい', '親しみやすい'], '「有り難し」は「存在することが難しい」という成り立ちで、「めったにない」を意味します。', '現代語と意味が異なる古語'],
  ['幼い子を「うつくし」と評する場合、適切な現代語訳は？', 'かわいらしい', ['たくましい', '恐ろしい', 'にぎやかだ'], '古語の「うつくし」は、小さいものや幼いものへの愛情を表し、「かわいらしい」と訳します。', '形容詞の意味'],
  ['古語「つとめて」が表す時間帯は？', '早朝', ['正午', '夕方', '真夜中'], '「つとめて」は「早朝」。文脈によっては「翌朝」を表すこともあります。', '時を表す古語'],
  ['古語「つきづきし」の意味として適切なものは？', 'ふさわしい', ['月が明るい', '落ち着きがない', '悲しい'], '「つきづきし」は「似つかわしい」「ふさわしい」という意味です。', '形容詞の意味'],
  ['眠っていた人が「おどろく」。この「おどろく」の訳として適切なものは？', '目を覚ます', ['大声で叫ぶ', '走り出す', '夢を見る'], '古語の「おどろく」には「はっと気づく」「目を覚ます」という意味があります。ここでは眠りから覚める場面です。', '文脈に応じた多義語'],
  ['古語「ののしる」が、大勢の声について使われる場合の意味は？', '大声で騒ぐ', ['静かに祈る', 'こっそり相談する', '眠りにつく'], '古語の「ののしる」には「大声で騒ぐ」という意味があります。現代語の「悪口を言う」だけで考えないことが大切です。', '現代語と意味が異なる古語'],
  ['古語「やむごとなし」が、人物の身分について表す意味は？', '高貴である', ['仕事がない', '幼い', '身分が低い'], '「やむごとなし」は「捨てておけない」という意味から、「大切だ」「高貴だ」などを表します。', '身分を表す古語'],
  ['古語「やがて」の代表的な意味として適切なものは？', 'そのまま', ['いつか遠い将来', 'なぜなら', '少しずつ'], '古語の「やがて」は「そのまま」「すぐに」などの意味を持ちます。現代語と同じ意味に限定しないようにします。', '副詞の意味'],
  ['古語「をかし」が、景色や風情について表す意味として適切なものは？', '趣がある', ['不正である', '腹立たしい', '疲れた'], '「をかし」は「趣がある」「おもしろい」など、心を引かれる様子を表します。', '美的感覚を表す古語'],
  ['「あはれなり」が表す心情として適切なものは？', 'しみじみと心を動かされる', ['何も感じない', '急いでいる', '眠くてたまらない'], '「あはれなり」は、物事に触れてしみじみと心を動かされる様子を表します。悲しみだけに限りません。', '感動を表す古語'],
  ['古語「いみじ」が程度について表す意味は？', 'はなはだしい', ['わずかである', '同じである', '新しい'], '「いみじ」は「はなはだしい」が基本。文脈に応じて「すばらしい」「ひどい」など、よい意味にも悪い意味にもなります。', '文脈に応じた多義語'],
  ['古語「いかで」が疑問を表すときの意味は？', 'どうして・どのようにして', ['いつも', '少しだけ', 'そのうち'], '疑問の「いかで」は「どうして」「どのようにして」。願望を表す用法との区別は文脈で判断します。', '疑問を表す副詞'],
  ['古語「まめなり」が人柄について表す意味として適切なものは？', 'まじめだ・誠実だ', ['小柄だ', '気が短い', '派手だ'], '「まめなり」は「まじめだ」「誠実だ」「実用的だ」などの意味を持ちます。', '人柄を表す古語'],
  ['古語「すさまじ」が、調和しない様子について表す意味は？', '興ざめだ', ['勇ましい', 'うれしい', 'かわいらしい'], '「すさまじ」は「興ざめだ」「殺風景だ」などを表します。現代語の「すさまじい」と区別します。', '現代語と意味が異なる古語'],
];

const ENGLISH: Example[] = [
  ['She ___ tennis every Sunday. 空欄に入るものは？', 'plays', ['play', 'playing', 'played'], 'every Sunday は習慣を表します。現在形で、主語が三人称単数の She なので plays を使います。', '三人称単数の現在形'],
  ['They ___ in the library now. 空欄に入るものは？', 'are', ['is', 'am', 'be'], '主語 They に対応する現在形の be 動詞は are です。', 'be動詞'],
  ['I ___ Kyoto yesterday. 空欄に入るものは？', 'visited', ['visit', 'visiting', 'visits'], 'yesterday は過去の時を表すため、動詞 visit の過去形 visited を使います。', '一般動詞の過去形'],
  ['He is ___ English now. 空欄に入るものは？', 'studying', ['study', 'studies', 'studied'], '現在進行形は be 動詞＋動詞の ing 形です。study の ing 形は studying です。', '現在進行形'],
  ['I have already ___ my homework. 空欄に入るものは？', 'finished', ['finish', 'finishing', 'finishes'], '現在完了は have / has＋過去分詞で表します。finish の過去分詞は finished です。', '現在完了の形'],
  ['Ken is ___ than Tom. 空欄に入るものは？', 'taller', ['tall', 'tallest', 'the tallest'], 'than を使って2人を比べるので、tall の比較級 taller を使います。', '比較級'],
  ['This is ___ book I own. 空欄に入るものは？', 'the oldest', ['older', 'old', 'more old'], '持っている本の中で最も古いことを表すので、the＋最上級の the oldest を使います。', '最上級'],
  ['I want ___ English abroad. 空欄に入るものは？', 'to learn', ['learn', 'learning', 'learned'], '「〜したい」は want to＋動詞の原形。ここでは want to learn です。', '不定詞'],
  ['She enjoys ___ in the pool. 空欄に入るものは？', 'swimming', ['swim', 'to swim', 'swam'], 'enjoy の目的語として動詞を置く場合は、動名詞の ing 形を使います。', '動名詞'],
  ['He is ___ honest person. 空欄に入るものは？', 'an', ['a', 'some', 'many'], 'honest の h は発音せず、母音の音で始まるため、不定冠詞は an を使います。', '冠詞と発音'],
  ['The book ___ written in 1990. 空欄に入るものは？', 'was', ['is', 'has', 'did'], '1990年に書かれたという過去の受動態なので、was＋過去分詞 written を使います。', '受動態'],
  ['The girl ___ is playing the piano is my sister. 空欄に入るものは？', 'who', ['which', 'where', 'when'], '先行詞 The girl は人で、後ろの節の主語を補うので、関係代名詞 who を使います。', '主格の関係代名詞'],
  ['How ___ water do you need? 空欄に入るものは？', 'much', ['many', 'few', 'a few'], 'water はこの文では数えられない名詞です。量を尋ねるときは how much を使います。', '可算名詞と不可算名詞'],
  ['If it rains tomorrow, we ___ stay home. 空欄に入るものは？', 'will', ['are', 'were', 'have'], '未来のことでも、条件を表す if 節では現在形 rains を使い、主節は will stay で未来を表せます。', '条件節と未来'],
  ['We have lived here ___ 2020. 空欄に入るものは？', 'since', ['for', 'during', 'by'], 'since は継続の起点を示します。2020年からという意味なので since 2020 です。', '現在完了の継続'],
];

const KANBUN: Example[] = [
  ['返り点の「レ点」は、どのような順序で読むための記号？', 'すぐ下の一字を先に読み、その字に返る', ['必ず最初に読む', 'その字を読まない', '文の最後まで読んでから返る'], 'レ点が付いた字はいったん飛ばし、すぐ下の一字を読んでから返って読みます。', '返り点・レ点'],
  ['一二点だけを使う場合、番号が付いた字を読む順番は？', '一 → 二', ['二 → 一', '上にある番号から順に読む', '一も二も読まない'], '一二点は「一」の字を読んでから「二」の字に返ることを表します。', '返り点・一二点'],
  ['上下点だけで示された返読の順番は？', '上 → 下', ['下 → 上', '必ず行の上から下へ', 'どちらからでもよい'], '上下点では「上」の字を先に読み、「下」の字に返って読みます。', '返り点・上下点'],
  ['打消しの「不」を訓読するとき、基本となる読み方は？', '〜ず', ['〜のみ', '〜なり', '〜べし'], '「不」は打消しを表し、基本的に「〜ず」と訓読します。', '打消し'],
  ['再読文字「未」の基本的な訓読は？', 'いまだ〜ず', ['すでに〜たり', 'まさに〜べし', 'あに〜や'], '「未」は「いまだ〜ず」と読み、「まだ〜していない」という意味を表します。', '再読文字・未'],
  ['再読文字「将」の基本的な訓読は？', 'まさに〜んとす', ['いまだ〜ず', 'なんぞ〜や', 'ただ〜のみ'], '「将」は「まさに〜んとす」と読み、「今にも〜しようとする」などの意味を表します。', '再読文字・将'],
  ['再読文字「当」の基本的な訓読は？', 'まさに〜べし', ['いまだ〜ず', 'また〜か', 'ここに〜あり'], '「当」は「まさに〜べし」と読み、「当然〜すべきだ」などの意味を表します。', '再読文字・当'],
  ['「豈〜哉」を反語として訓読するときの基本形は？', 'あに〜や', ['いまだ〜ず', 'もし〜ならば', 'ただ〜のみ'], '「豈〜哉」は「あに〜や」と読み、「どうして〜だろうか、いや〜ない」という反語を表します。', '反語'],
  ['「不知」を書き下したものとして適切なのは？', '知らず', ['知るべし', '知るなり', '知らんとす'], '「不」は打消しを表すので、「知」の後に返って「知らず」と読みます。', '打消しの書き下し'],
  ['「未見」を書き下したものとして適切なのは？', '未だ見ず', ['既に見る', '見るべし', '見んとす'], '再読文字「未」は先に「いまだ」、後に「ず」と読み、「未だ見ず」となります。', '再読文字の書き下し'],
  ['比況を表す「如」の基本的な読み方は？', 'ごとし', ['なり', 'べし', 'ず'], '「如」は比況の用法では「ごとし」と読み、「〜のようだ」という意味を表します。', '比況'],
  ['文末で判断・断定を表す「也」の基本的な読み方は？', 'なり', ['ず', 'べし', 'かつ'], '文末で判断や断定を表す「也」は、基本的に「なり」と訓読します。', '断定'],
];

export function createDemoData(now = new Date()): StudyData {
  const todayStart = Date.parse(`${formatJapanDate(now.toISOString())}T00:00:00+09:00`);
  const atDay = (daysAgo: number, minute = 0) => new Date(todayStart - daysAgo * 86_400_000
    + 19 * 60 * 60 * 1_000 + minute * 60_000).toISOString();
  const createdAt = atDay(21);
  const topicSpecs: [string, string, Subject, string, Example[]][] = [
    ['topic-kobun', '古文単語のきほん', '古文', '現代語との違いに気をつけて、よく出る古語を少しずつ。', KOBUN],
    ['topic-english', '英語の文法をひとつずつ', '英語', '時制・比較・不定詞など、短い例文で基礎を確認。', ENGLISH],
    ['topic-kanbun', '漢文の読み方入門', '漢文', '返り点と基本句形を、ひとつずつ確かめよう。', KANBUN],
  ];
  const topics: Topic[] = topicSpecs.map(([id, title, subject, description, examples]) => ({
    id, title, subject, description, createdAt, targetCount: examples.length,
  }));
  const questions: Question[] = topicSpecs.flatMap(([topicId, , , , examples]) => examples.map((example, index) => {
    const [prompt, answer, distractors, explanation, learningPoint] = example;
    const correctIndex = index % 4;
    const choices: string[] = [...distractors];
    choices.splice(correctIndex, 0, answer);
    return {
      id: `${topicId}-q${String(index + 1).padStart(2, '0')}`, topicId, prompt, choices,
      correctIndex, explanation, learningPoint, sourceIds: [],
      sourceNote: '動作確認用に手作業で作成した例題です。アップロードした教材からの生成ではありません。',
      status: 'published', version: 1, createdAt, publishedAt: createdAt,
    };
  }));
  const drafts: [string, Example][] = [
    ['topic-kobun', ['古語「あまた」の意味として適切なものは？', 'たくさん', ['ひとつだけ', 'まったく〜ない', 'おそらく'], '「あまた」は数や量が多いことを表します。', '数量を表す古語']],
    ['topic-english', ['You ___ wear a seat belt.「〜しなければならない」にするには？', 'must', ['may', 'might', 'would'], '義務を表す must を使うと「シートベルトを着用しなければならない」という意味になります。', '助動詞 must']],
    ['topic-kanbun', ['禁止を表す「勿」の基本的な読み方は？', '〜なかれ', ['〜べし', '〜のみ', '〜なり'], '「勿」は禁止を表し、「〜なかれ」と訓読します。', '禁止']],
  ];
  for (const [topicId, [prompt, answer, distractors, explanation, learningPoint]] of drafts) {
    questions.push({
      id: `${topicId}-draft01`, topicId, prompt, choices: [answer, ...distractors], correctIndex: 0,
      explanation, learningPoint, sourceIds: [], sourceNote: 'デモ用のレビュー待ち問題。内容を確認して公開してください。',
      status: 'draft', needsReview: true, version: 1, createdAt: atDay(1),
    });
  }
  const attempts: Attempt[] = [];
  const exposures: Exposure[] = [];
  const sessions: PracticeSession[] = [];
  const historyPool = [
    ...questions.filter((question) => question.topicId === 'topic-kobun').slice(0, 8),
    ...questions.filter((question) => question.topicId === 'topic-english').slice(0, 8),
    ...questions.filter((question) => question.topicId === 'topic-kanbun').slice(0, 5),
  ];
  // Seven past sessions leave today's work untouched, with both new material and reviews available.
  for (let daysAgo = 8; daysAgo >= 1; daysAgo -= 1) {
    if (daysAgo === 4) continue;
    const sessionId = `demo-session-${daysAgo}`;
    const start = (8 - daysAgo) * 3;
    const selected = Array.from({ length: 10 }, (_, index) => historyPool[(start + index) % historyPool.length]);
    sessions.push({ id: sessionId, userId: 'student-demo', mode: 'daily',
      questionIds: selected.map((question) => question.id), createdAt: atDay(daysAgo), completedAt: atDay(daysAgo, 10) });
    selected.forEach((question, index) => {
      // Improvement is illustrative sample data, never a claim about a real student.
      const correct = daysAgo >= 5 ? (index + daysAgo) % 3 !== 0 : (index + daysAgo) % 6 !== 0;
      const suffix = `${daysAgo}-${index}`;
      exposures.push({ id: `demo-exposure-${suffix}`, userId: 'student-demo', questionId: question.id,
        questionVersion: question.version, sessionId, shownAt: atDay(daysAgo, index) });
      attempts.push({ id: `demo-attempt-${suffix}`, userId: 'student-demo', questionId: question.id,
        questionVersion: question.version, sessionId,
        selectedIndex: correct ? question.correctIndex : (question.correctIndex + 1) % question.choices.length,
        correct, answeredAt: atDay(daysAgo, index + 0.5) });
    });
  }
  return {
    topics, sources: [], questions, attempts, exposures, sessions,
    jobs: [{ id: 'demo-job-review', topicId: 'topic-kobun', status: 'review', targetCount: 1,
      generatedCount: 1, createdAt: atDay(1) }],
    profiles: [
      { id: 'parent-demo', familyId: 'family-demo', name: 'お母さん', role: 'parent' },
      { id: 'student-demo', familyId: 'family-demo', name: '高校生', role: 'student' },
    ],
  };
}
