import type { GenerationJob, LearningPlan, PlanningSample, PlanningTurn, PracticeSession, Profile, Question, StudyData, Topic } from './types';

import { asPracticeQuestion, isPracticeReadyQuestion, mayPracticeLibraryTopic, topicOwnerId } from './library-policy';
import { arrangementScopeSummary, ownPlanTagsForTopic } from './plan-organization';
import type { LibraryDeliveryInput, LibraryDeliveryResult } from './library-delivery';

export type DemoPracticeSession = PracticeSession & { questionSnapshots?: Question[] };

export function demoSessionQuestions(session: PracticeSession, current: Question[]): Question[] {
  const snapshots = (session as DemoPracticeSession).questionSnapshots;
  const source = snapshots?.length === session.questionIds.length ? snapshots : current;
  return session.questionIds.map(id => source.find(question => question.id === id)).filter((question): question is Question => !!question);
}

function normalizeDemoOwnership(data: StudyData): StudyData {
  const topics = data.topics.map(topic => ({ ...topic, ownerId: topicOwnerId(data, topic) }));
  return { ...data, topics, questions: data.questions.map(question => ({ ...question,
    ownerId: question.ownerId ?? topics.find(topic => topic.id === question.topicId)?.ownerId })) };
}

/** All roles see their own workspace; legacy public and other people's records stay private. */
export function demoStudyDataForProfile(data: StudyData, profile: Profile): StudyData {
  data = normalizeDemoOwnership(data);
  const testAllowed = (item: { testOnly?: boolean }) => !item.testOnly || profile.accessLevel === 'superuser';
  const plans = data.plans.filter(plan => plan.ownerId === profile.id && !plan.libraryTopicId && testAllowed(plan));
  const planIds = new Set(plans.map(plan => plan.id));
  const topics = data.topics.filter(topic => !topic.libraryPublished && topicOwnerId(data, topic) === profile.id
    && (!topic.audienceUserId || topic.audienceUserId === profile.id) && testAllowed(topic));
  const topicIds = new Set(topics.map(topic => topic.id));
  const sources = data.sources.filter(source => testAllowed(source) && (source.ownerId === profile.id
    || !source.ownerId && !!source.topicId && topicIds.has(source.topicId)));
  const sourceIds = new Set(sources.map(source => source.id));
  const questions = data.questions.filter(question => topicIds.has(question.topicId)
    && (!question.ownerId || question.ownerId === profile.id)
    && (!question.audienceUserId || question.audienceUserId === profile.id)
    && (!question.planId || planIds.has(question.planId)) && testAllowed(question));
  const questionIds = new Set(questions.map(question => question.id));
  return {
    topics, plans: plans.map(plan => ({ ...plan, sourceIds: plan.sourceIds.filter(id => sourceIds.has(id)) })),
    questions: questions.map(question => ({ ...question, choices: [...question.choices], sourceIds: question.sourceIds.filter(id => sourceIds.has(id)) })),
    planningTurns: data.planningTurns.filter(turn => planIds.has(turn.planId) && turn.requestedBy === profile.id),
    sources,
    jobs: data.jobs.filter(job => topicIds.has(job.topicId) && (!job.planId || planIds.has(job.planId)) && job.requestedBy === profile.id && testAllowed(job)),
    attempts: data.attempts.filter(attempt => attempt.userId === profile.id && questionIds.has(attempt.questionId)),
    exposures: data.exposures.filter(exposure => exposure.userId === profile.id && questionIds.has(exposure.questionId)),
    sessions: data.sessions.filter(session => session.userId === profile.id && session.questionIds.every(id => questionIds.has(id)))
      .map(({ questionSnapshots: _privateSnapshots, ...session }: DemoPracticeSession) => session),
    profiles: data.profiles.filter(member => member.id === profile.id),
  };
}

/** Editing may show the owner's answers; practice reveals them only after a recorded answer. */
export function demoPracticeQuestionView(question: Question, answered: boolean): Question {
  return { ...question, correctIndex: answered ? question.correctIndex : -1,
    explanation: answered ? question.explanation : '', learningPoint: answered ? question.learningPoint : '', sourceIds: [], sourceNote: '' };
}

export function updateDemoQuestion(data: StudyData, profile: Profile, id: string, patch: Partial<Question>, now = new Date().toISOString()): StudyData {
  const question = demoStudyDataForProfile(data, profile).questions.find(item => item.id === id);
  if (!question) throw new Error('自分の問題を選んでください。');
  const choices = (patch.choices ?? question.choices).map(choice => choice.trim());
  const correctIndex = patch.correctIndex ?? question.correctIndex;
  const prompt = (patch.prompt ?? question.prompt).trim();
  const explanation = (patch.explanation ?? question.explanation).trim();
  if (!prompt || prompt.length > 6000 || !explanation || explanation.length > 6000 || choices.length < 2 || choices.length > 6
    || choices.some(choice => !choice || choice.length > 2000) || new Set(choices).size !== choices.length
    || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= choices.length
    || (patch.learningPoint ?? question.learningPoint).length > 1000 || (patch.sourceNote ?? question.sourceNote).length > 3000) throw new Error('問題文・選択肢・正解・解説を確認してください。');
  const status = patch.status === 'archived' ? 'archived' : question.testOnly ? 'published' : patch.status === 'approved' ? 'approved' : 'draft';
  const needsReview = question.testOnly ? false : patch.needsReview ?? (status === 'draft' ? true : question.needsReview);
  if (status === 'approved' && needsReview) throw new Error('原本・正解・解説を確認してから確認済みにしてください。');
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  if (data.questions.some(item => item.id !== id && item.topicId === question.topicId && normalize(item.prompt) === normalize(prompt))) throw new Error('同じ問題文がこの問題集に登録されています。');
  // Only content is editable. IDs, owner, source links and audience cannot be rewritten through a patch.
  return { ...data, questions: data.questions.map(item => item.id === id ? { ...item, prompt, choices, correctIndex, explanation,
    learningPoint: patch.learningPoint ?? item.learningPoint, sourceNote: patch.sourceNote ?? item.sourceNote,
    status, needsReview, publishedAt: status === 'published' ? now : undefined, version: item.version + 1 } : item) };
}

/** Saved private questions belong to their owner, regardless of the old role label. */
export function demoPracticeQuestions(data: StudyData, profile: Profile, topicId?: string): Question[] {
  data = normalizeDemoOwnership(data);
  const own = demoStudyDataForProfile(data, profile);
  const topic = own.topics.find(item => item.id === topicId);
  if (topicId && (!topic || !mayPracticeLibraryTopic(data, profile, topic))) throw new Error('ご自身の問題集を選んでください。');
  return own.questions.filter(question => (!topicId || question.topicId === topicId) && isPracticeReadyQuestion(question)
    && own.topics.some(topic => topic.id === question.topicId && mayPracticeLibraryTopic(data, profile, topic))).map(asPracticeQuestion);
}

export function demoSessionAllowed(session: PracticeSession, questions: Question[], profile: Profile): boolean {
  const allowed = new Set(questions.map(question => question.id));
  if (session.userId !== profile.id || !session.questionIds.length || !session.questionIds.every(id => allowed.has(id))) return false;
  const snapshots = (session as DemoPracticeSession).questionSnapshots;
  if (!snapshots) return !questions.some(question => session.questionIds.includes(question.id) && question.testOnly);
  return snapshots.length === session.questionIds.length && new Set(snapshots.map(question => question.id)).size === session.questionIds.length && snapshots.every(snapshot => {
    const current = questions.find(question => question.id === snapshot.id);
    return session.questionIds.includes(snapshot.id) && !!current && isPracticeReadyQuestion(current) && current.version === snapshot.version;
  });
}

const PRIVATE_STUDY_ONLY = '公開・共有・配布は利用できません。自分の問題として練習してください。';
export function publishDemoLibrary(_data: StudyData, _profile: Profile, _topicId: string, _now?: string, _createId?: () => string): never { throw new Error(PRIVATE_STUDY_ONLY); }
export function requestDemoLibraryPublication(_data: StudyData, _profile: Profile, _topicId: string, _now?: string): never { throw new Error(PRIVATE_STUDY_ONLY); }
export function addDemoLibraryPlan(_data: StudyData, _profile: Profile, _topicId: string, _now?: string, _createId?: () => string): never { throw new Error(PRIVATE_STUDY_ONLY); }
export async function deliverDemoTopic(_data: StudyData, _profile: Profile, _input: LibraryDeliveryInput, _now?: string): Promise<LibraryDeliveryResult & { data: StudyData }> { throw new Error(PRIVATE_STUDY_ONLY); }

function demoSamples(data: StudyData, plan: LearningPlan): PlanningSample[] {
  const topicIds = new Set(data.topics.filter(topic => topic.subject === plan.subject && !topic.libraryPublished && !topic.testOnly && topicOwnerId(data, topic) === plan.ownerId).map(topic=>topic.id));
  const source = plan.arrangementExamples?.length ? plan.arrangementExamples : data.questions.filter(question=>topicIds.has(question.topicId)&&question.status!=='archived'&&(!question.ownerId||question.ownerId===plan.ownerId)&&(!question.audienceUserId||question.audienceUserId===plan.ownerId));
  const fallback: PlanningSample[] = [
    {prompt:'この画面の試作3問は、何を確かめるためのもの？',choices:['出し方と難しさ','試験の合否','学校の成績','他の人の点数'],correctIndex:0,explanation:'少ない問題で出し方を確かめてから、まとめて作る数を選びます。',learningPoint:'試作を見てから分量を決める',sourceIds:[],sourceNote:'操作確認用の例題です。',needsReview:false},
    {prompt:'サンプルの出し方を変えたいときは？',choices:['コメントで希望を伝える','最初に300問作る','元の教材を消す','関係のない問題を増やす'],correctIndex:0,explanation:'調整するボタンから希望を送って、変更後の3問を確認します。デモでは用意済みの例題を表示します。',learningPoint:'少しずつ調整する',sourceIds:[],sourceNote:'操作確認用の例題です。',needsReview:false},
    {prompt:'7日分、1日10問でまとめて作る問題数は？',choices:['70問','17問','7問','100問'],correctIndex:0,explanation:'7日 × 10問で70問です。試作3問は、新しく作る総数には含みません。',learningPoint:'日数と1日の問数で計算する',sourceIds:[],sourceNote:'操作確認用の例題です。',needsReview:false},
  ];
  return Array.from({length:3},(_,index)=>{const item=source[index%Math.max(1,source.length)]??fallback[index];return {prompt:item.prompt,choices:[...item.choices],correctIndex:item.correctIndex,explanation:item.explanation,learningPoint:item.learningPoint,sourceIds:[],sourceNote:'操作確認用の例題です。AIへの送信や教材の読み取りはしていません。',needsReview:false};});
}

export function arrangeDemoTopic(data: StudyData, profile: Profile, topicId: string, now = new Date().toISOString(), createId = () => crypto.randomUUID()): {data:StudyData;plan:LearningPlan} {
  data=normalizeDemoOwnership(data);
  const topic=data.topics.find(item=>item.id===topicId);
  if(!topic || topic.libraryPublished || topicOwnerId(data,topic)!==profile.id || !mayPracticeLibraryTopic(data, profile, topic)) throw new Error('利用できる問題集からアレンジしてください。');
  const questions=demoStudyDataForProfile(data, profile).questions.filter(question=>question.topicId===topic.id&&question.status!=='archived');
  if(!questions.length) throw new Error('問題が保存されてからアレンジできます。');
  const plan:LearningPlan={id:createId(),ownerId:profile.id,title:`${topic.title}のアレンジ`.slice(0,150),subject:topic.subject,questionTemplate:topic.questionTemplate,
    tags:ownPlanTagsForTopic(data,profile,topic),
    goal:`「${topic.title.slice(0,150)}」の出題方法や難しさを相談し、まず3問で確かめる。元の問題集は変更しない。\n${arrangementScopeSummary(topic,questions)}`,difficulty:'相談して決める',dailyQuestionTarget:10,sourceIds:[],version:1,createdAt:now,updatedAt:now,sampleFirst:true,arrangedFromTopicId:topic.id,
    arrangementExamples:questions.slice(0,3).map(question=>({prompt:question.prompt,choices:[...question.choices],correctIndex:question.correctIndex,explanation:question.explanation,learningPoint:question.learningPoint,sourceIds:[],sourceNote:'アレンジ元の問題例',needsReview:!!question.needsReview})),...(topic.testOnly?{testOnly:true}:{})};
  return {data:{...data,plans:[...data.plans,plan]},plan};
}

/** Demonstrate the workflow with clearly labelled examples; no model or source analysis runs. */
export function addDemoPlanningTurn(data: StudyData, profile: Profile, planId: string, message: string, now = new Date().toISOString(), createId = () => crypto.randomUUID()): StudyData {
  const plan = data.plans.find(item => item.id === planId && item.ownerId === profile.id);
  if (!plan || (plan.testOnly && profile.accessLevel !== 'superuser')) throw new Error('ご自身の相談を選んでください。');
  if (!message.trim()) throw new Error('相談したいことを入力してください。');
  const id = createId();
  const updated = { ...plan, version: plan.version + 1, updatedAt: now };
  const turn: PlanningTurn = { id, planId, requestedBy: profile.id, version: updated.version, status: 'complete', samplePreview: true, message: message.trim(),
    reply: 'これは操作確認用のサンプル提案です。AIには送信しておらず、教材の写真やPDFも読み取っていません。\n\n用意済みの例題3問で、調整・分量選び・作成・練習の流れを試せます。入力した希望やコメントは履歴に残りますが、サンプル問題の内容には反映されません。',
    proposals: [{ id: `${id}:0`, title: `${plan.subject}のサンプル問題`, subject: plan.subject,
      description: '用意済みの例題で操作を確認します。AIによる作問ではありません。', instructions: '操作確認用の例題を選んだ分量だけ複製する。教材の内容やコメントから生成した問題とは表示しない。',
      difficulty: 'サンプル', targetCount: 10, format: 'multiple-choice', sourceIds: [], samples:demoSamples(data,plan) }], createdAt: now, completedAt: now };
  return { ...data, plans: data.plans.map(item => item.id === plan.id ? updated : item), planningTurns: [...data.planningTurns, turn] };
}

export function generateDemoProposal(data: StudyData, profile: Profile, planId: string, turnId: string, proposalId: string, targetCount: number, now = new Date().toISOString(), createId = () => crypto.randomUUID(), approval?: {approveSamples:boolean;dailyQuestionTarget?:number;plannedDays?:number}): { data: StudyData; topic: Topic } {
  const plan = data.plans.find(item => item.id === planId && item.ownerId === profile.id);
  const turn = data.planningTurns.find(item => item.id === turnId && item.planId === planId && item.version === plan?.version && item.status === 'complete');
  const proposal = turn?.proposals?.find(item => item.id === proposalId);
  if (!plan || !proposal || (plan.testOnly && profile.accessLevel !== 'superuser')) throw new Error('最新のサンプル提案を選んでください。');
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 300) throw new Error('問題数を確認してください。');
  if(!approval?.approveSamples || proposal.samples?.length!==3) throw new Error('最新の試作3問を確認してから、まとめて作成してください。');
  if(approval.plannedDays!==undefined && (!Number.isInteger(approval.plannedDays)||approval.plannedDays<1||!Number.isInteger(approval.dailyQuestionTarget)||approval.dailyQuestionTarget!<1||approval.plannedDays*approval.dailyQuestionTarget! !==targetCount)) throw new Error('日数と1日の問題数を確認してください。');
  const previous = data.jobs.find(job => job.planId === planId && job.turnId === turnId && job.proposalId === proposalId);
  const previousTopic = data.topics.find(topic => topic.id === previous?.topicId);
  if (previousTopic) return { data, topic: previousTopic };
  const originals = Array.from({length:targetCount},(_,index)=>proposal.samples![index%3]);
  const topic: Topic = { id: createId(), ownerId:profile.id, title: proposal.title, subject: plan.subject, questionTemplate:plan.questionTemplate, description: '操作確認用のサンプル。AIが作成した問題ではありません。',
    targetCount: originals.length, createdAt: now, planId: plan.id, ...(plan.testOnly ? { testOnly: true } : {}), audienceUserId: profile.id };
  const published = true;
  const questions: Question[] = originals.map(original => ({ ...original, id: createId(), ownerId:profile.id, topicId: topic.id, planId: plan.id,
    sourceIds: [], sourceNote: '操作確認用に用意されたサンプルです。教材やコメントからAIが生成した問題ではありません。',
    version: 1, createdAt: now, status: published ? 'published' : 'draft', needsReview: !published, publishedAt: published ? now : undefined,
    ...(plan.testOnly ? { testOnly: true } : {}), audienceUserId: profile.id }));
  const job: GenerationJob = { id: createId(), topicId: topic.id, planId: plan.id, questionTemplate:plan.questionTemplate, turnId, proposalId, requestedBy: profile.id,
    status: 'review', targetCount: questions.length, generatedCount: questions.length, createdAt: now, approvedSamples:proposal.samples,approvedSampleVersion:turn!.version,dailyQuestionTarget:approval.dailyQuestionTarget,plannedDays:approval.plannedDays,
    ...(plan.testOnly ? { testOnly: true } : {}), audienceUserId: profile.id };
  return { data: { ...data, plans:data.plans.map(item=>item.id===plan.id?{...item,version:item.version+1,updatedAt:now,requestedQuestionCount:targetCount,...(approval.dailyQuestionTarget?{dailyQuestionTarget:approval.dailyQuestionTarget}:{}),...(approval.plannedDays?{plannedDays:approval.plannedDays}:{})}:item), topics: [...data.topics, topic], questions: [...data.questions, ...questions], jobs: [...data.jobs, job] }, topic };
}
