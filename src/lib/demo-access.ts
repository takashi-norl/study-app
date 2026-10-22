import type { GenerationJob, LearningPlan, PlanningTurn, PracticeSession, Profile, Question, StudyData, Topic } from './types';

import { asPracticeQuestion, isPracticeReadyQuestion, mayPracticeLibraryTopic, topicOwnerId } from './library-policy';

export type DemoPracticeSession = PracticeSession & { questionSnapshots?: Question[] };
type DemoTopic = Topic & { demoLibraryRevision?: string };

export function demoSessionQuestions(session: PracticeSession, current: Question[]): Question[] {
  const snapshots = (session as DemoPracticeSession).questionSnapshots;
  const source = snapshots?.length === session.questionIds.length ? snapshots : current;
  return session.questionIds.map(id => source.find(question => question.id === id)).filter((question): question is Question => !!question);
}

function demoRevision(data: StudyData,topic: Topic) {
  return JSON.stringify([topic.id,topic.title,topic.subject,topic.description,data.questions.filter(q=>q.topicId===topic.id && q.status!=='archived').map(q=>[q.id,q.version]).sort()]);
}
function normalizeDemoLibrary(data: StudyData): StudyData {
  const topics=data.topics.map(topic=>topic.libraryPublished ? topic : {...topic,ownerId:topicOwnerId(data,topic) ?? data.profiles.find(p=>p.role==='student')?.id,currentSourceRevision:demoRevision(data,topic),publishedSourceRevision:data.topics.find(t=>t.libraryPublished && t.librarySourceTopicId===topic.id && t.libraryRevision===demoRevision(data,topic))?.libraryRevision ?? data.topics.filter(t=>t.libraryPublished && t.librarySourceTopicId===topic.id).at(-1)?.libraryRevision});
  return {...data,topics,questions:data.questions.map(q=>({...q,ownerId:topics.find(t=>t.id===q.topicId)?.ownerId}))};
}

function testIds(data: StudyData) {
  const plans = new Set(data.plans.filter(plan => plan.testOnly).map(plan => plan.id));
  const topics = new Set(data.topics.filter(topic => topic.testOnly || (topic.planId && plans.has(topic.planId))).map(topic => topic.id));
  const questions = new Set(data.questions.filter(question => question.testOnly || topics.has(question.topicId) || (question.planId && plans.has(question.planId))).map(question => question.id));
  return { plans, topics, questions };
}

/** Demo keeps one local family store, but the learner sees only their own allowed view. */
export function demoStudyDataForProfile(data: StudyData, profile: Profile): StudyData {
  data=normalizeDemoLibrary(data);
  if (profile.role === 'parent') return data;
  const hidden = testIds(data);
  const plans = data.plans.filter(plan => !hidden.plans.has(plan.id) && plan.ownerId === profile.id);
  const planIds = new Set(plans.map(plan => plan.id));
  const topics = data.topics.filter(topic => !hidden.topics.has(topic.id) && (topic.libraryPublished || topicOwnerId(data,topic) === profile.id))
    .map(({ librarySourceTopicId: _privateOrigin, demoLibraryRevision: _privateRevision, ...topic }: DemoTopic) => topic);
  const topicIds = new Set(topics.map(topic => topic.id));
  const adopted = new Set(plans.filter(plan => plan.libraryTopicId).map(plan => plan.libraryTopicId));
  const library = new Set(topics.filter(topic => topic.libraryPublished).map(topic => topic.id));
  const questions = data.questions.filter(question => !hidden.questions.has(question.id) && topicIds.has(question.topicId)
    && (!library.has(question.topicId) || adopted.has(question.topicId))
    && (!question.ownerId || question.ownerId === profile.id) && isPracticeReadyQuestion(question));
  const questionIds = new Set(questions.map(question => question.id));
  return {
    ...data, topics, plans,
    questions: questions.map(asPracticeQuestion).map(question => ({ ...question, correctIndex: -1, explanation: '', learningPoint: '', sourceIds: [], sourceNote: '' })),
    planningTurns: data.planningTurns.filter(turn => planIds.has(turn.planId)),
    sources: data.sources.filter(source => !source.testOnly && source.ownerId === profile.id && (!source.topicId || !hidden.topics.has(source.topicId))),
    jobs: data.jobs.filter(job => !job.testOnly && !hidden.topics.has(job.topicId) && (!job.planId || !hidden.plans.has(job.planId)) && job.requestedBy === profile.id),
    attempts: data.attempts.filter(attempt => attempt.userId === profile.id && questionIds.has(attempt.questionId)),
    exposures: data.exposures.filter(exposure => exposure.userId === profile.id && questionIds.has(exposure.questionId)),
    sessions: data.sessions.filter(session => session.userId === profile.id && session.questionIds.every(id => questionIds.has(id)))
      .map(({ questionSnapshots: _privateSnapshots, ...session }: DemoPracticeSession) => session),
  };
}

/** Private practice belongs to its owner; parents can also rehearse isolated test sets. */
export function demoPracticeQuestions(data: StudyData, profile: Profile, topicId?: string): Question[] {
  data=normalizeDemoLibrary(data);
  const topic=data.topics.find(item=>item.id===topicId);
  if(topicId && (!topic || !mayPracticeLibraryTopic(data,profile,topic))) throw new Error('ご自身の問題集か、追加済みの公開問題集を選んでください。');
  return data.questions.filter(question=>(!topicId || question.topicId===topicId) && isPracticeReadyQuestion(question)
    && data.topics.some(topic=>topic.id===question.topicId && mayPracticeLibraryTopic(data,profile,topic))
    && (profile.role==='parent' || !question.testOnly)).map(asPracticeQuestion);
}

export function demoSessionAllowed(session: PracticeSession, questions: Question[], profile: Profile): boolean {
  const allowed = new Set(questions.map(question => question.id));
  if (session.userId !== profile.id || !session.questionIds.length || !session.questionIds.every(id => allowed.has(id))) return false;
  if (profile.role === 'parent') {
    const snapshots = (session as DemoPracticeSession).questionSnapshots;
    return !!snapshots && snapshots.length === session.questionIds.length && snapshots.every(snapshot => {
      const current = questions.find(question => question.id === snapshot.id);
      return !!current && isPracticeReadyQuestion(current) && current.version === snapshot.version;
    });
  }
  return true;
}

export function publishDemoLibrary(data: StudyData, profile: Profile, topicId: string, now = new Date().toISOString(), createId = () => crypto.randomUUID()): { data: StudyData; topic: Topic } {
  if (profile.role !== 'parent') throw new Error('管理者だけがライブラリへ公開できます。');
  data=normalizeDemoLibrary(data);
  const original = data.topics.find(topic => topic.id === topicId && !topic.libraryPublished);
  const owner = data.profiles.find(item => item.id === original?.ownerId);
  if(owner && owner.familyId!==profile.familyId) throw new Error('ご家族の問題集を選んでください。');
  if (!original || !owner || (owner.role==='student' && (original.testOnly || original.publicationRequest?.revision!==original.currentSourceRevision))) throw new Error('学習者の問題集は本人の公開依頼後に公開できます。');
  if(data.jobs.some(job=>job.topicId===topicId && ['queued','running'].includes(job.status))) throw new Error('作問が終わってから公開してください。');
  const originals = data.questions.filter(question => question.topicId === original.id && question.status !== 'archived');
  if (!originals.length) throw new Error('公開できる問題がまだありません。');
  const revision = demoRevision(data,original);
  const previous = data.topics.find(topic => topic.libraryPublished && topic.librarySourceTopicId === original.id && (topic as DemoTopic).demoLibraryRevision === revision);
  if (previous) return { data, topic: previous };
  const topic: DemoTopic = { id: createId(), title: original.title, subject: original.subject, description: original.description,
    targetCount: originals.length, createdAt: now, libraryPublished: true, librarySourceTopicId: original.id, demoLibraryRevision: revision, libraryRevision: revision };
  const questions: Question[] = originals.map(question => ({ id: createId(), topicId: topic.id, prompt: question.prompt,
    choices: [...question.choices], correctIndex: question.correctIndex, explanation: question.explanation, learningPoint: question.learningPoint,
    sourceIds: [], sourceNote: 'ライブラリに公開された問題です。', status: 'published', needsReview: question.needsReview, aiGenerated: question.aiGenerated, version: 1, createdAt: now, publishedAt: now }));
  return { data: normalizeDemoLibrary({ ...data, topics: [...data.topics, topic], questions: [...data.questions, ...questions] }), topic };
}

export function requestDemoLibraryPublication(data: StudyData,profile: Profile,topicId: string,now=new Date().toISOString()) {
  data=normalizeDemoLibrary(data);
  const original=data.topics.find(topic=>topic.id===topicId && !topic.libraryPublished && !topic.testOnly && topic.ownerId===profile.id);
  if(!original) throw new Error('自分の非公開の問題集から公開を依頼してください。');
  if(data.jobs.some(job=>job.topicId===topicId && ['queued','running'].includes(job.status))) throw new Error('作問が終わってから公開を依頼してください。');
  if(!data.questions.some(q=>q.topicId===topicId && q.status!=='archived')) throw new Error('問題が保存されてから公開を依頼してください。');
  const request=original.publicationRequest?.revision===original.currentSourceRevision ? original.publicationRequest : {requestedBy:profile.id,requestedAt:now,revision:original.currentSourceRevision!,sequence:(original.publicationRequest?.sequence ?? 0)+1};
  const topic={...original,publicationRequest:request};
  return {data:{...data,topics:data.topics.map(item=>item.id===topicId ? topic : item)},topic,request};
}

export function addDemoLibraryPlan(data: StudyData, profile: Profile, topicId: string, now = new Date().toISOString(), createId = () => crypto.randomUUID()): { data: StudyData; plan: LearningPlan } {
  const topic = data.topics.find(item => item.id === topicId && item.libraryPublished && !item.testOnly && !item.audienceUserId);
  if (!topic) throw new Error('ライブラリの問題集が見つかりません。');
  const previous = data.plans.find(plan => plan.ownerId === profile.id && plan.libraryTopicId === topic.id && !plan.testOnly);
  if (previous) return { data, plan: previous };
  const plan: LearningPlan = { id: createId(), ownerId: profile.id, title: topic.title, subject: topic.subject,
    goal: `${topic.title}を、1回10問ずつ練習する。`, difficulty: '解いてから調整する', dailyQuestionTarget: 10,
    requestedQuestionCount: topic.targetCount, libraryTopicId: topic.id, sourceIds: [], version: 1, createdAt: now, updatedAt: now };
  return { data: { ...data, plans: [...data.plans, plan] }, plan };
}

/** Demonstrate the workflow with clearly labelled examples; no model or source analysis runs. */
export function addDemoPlanningTurn(data: StudyData, profile: Profile, planId: string, message: string, now = new Date().toISOString(), createId = () => crypto.randomUUID()): StudyData {
  const plan = data.plans.find(item => item.id === planId && item.ownerId === profile.id);
  if (!plan || (plan.testOnly && profile.role !== 'parent')) throw new Error('ご自身の相談を選んでください。');
  if (!message.trim()) throw new Error('相談したいことを入力してください。');
  const id = createId();
  const updated = { ...plan, version: plan.version + 1, updatedAt: now };
  const turn: PlanningTurn = { id, planId, requestedBy: profile.id, version: updated.version, status: 'complete', message: message.trim(),
    reply: 'これは操作確認用のサンプル提案です。AIには送信しておらず、教材の写真やPDFも読み取っていません。\n\n用意済みの例題を最大10問使って、作成・練習・公開の流れを試せます。入力した希望やコメントは履歴に残りますが、サンプル問題の内容には反映されません。',
    proposals: [{ id: `${id}:0`, title: `${plan.subject}のサンプル問題`, subject: plan.subject,
      description: '用意済みの例題で操作を確認します。AIによる作問ではありません。', instructions: '操作確認用の例題を最大10問複製する。教材の内容やコメントから生成した問題とは表示しない。',
      difficulty: 'サンプル', targetCount: 10, format: 'multiple-choice', sourceIds: [] }], createdAt: now, completedAt: now };
  return { ...data, plans: data.plans.map(item => item.id === plan.id ? updated : item), planningTurns: [...data.planningTurns, turn] };
}

export function generateDemoProposal(data: StudyData, profile: Profile, planId: string, turnId: string, proposalId: string, targetCount: number, now = new Date().toISOString(), createId = () => crypto.randomUUID()): { data: StudyData; topic: Topic } {
  const plan = data.plans.find(item => item.id === planId && item.ownerId === profile.id);
  const turn = data.planningTurns.find(item => item.id === turnId && item.planId === planId && item.version === plan?.version && item.status === 'complete');
  const proposal = turn?.proposals?.find(item => item.id === proposalId);
  if (!plan || !proposal || (plan.testOnly && profile.role !== 'parent')) throw new Error('最新のサンプル提案を選んでください。');
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 300) throw new Error('問題数を確認してください。');
  const previous = data.jobs.find(job => job.planId === planId && job.turnId === turnId && job.proposalId === proposalId);
  const previousTopic = data.topics.find(topic => topic.id === previous?.topicId);
  if (previousTopic) return { data, topic: previousTopic };
  const exampleTopics = new Set(data.topics.filter(topic => !topic.testOnly && !topic.libraryPublished && !topic.planId && topic.subject === plan.subject).map(topic => topic.id));
  let originals = data.questions.filter(question => exampleTopics.has(question.topicId) && question.status === 'published' && !question.testOnly).slice(0, Math.min(10, targetCount));
  if (!originals.length) originals = [{ id: '', topicId: '', prompt: 'このサンプルで練習した記録が保存される場所は？', choices: ['このブラウザ', '本番の学習記録', '学校の成績表', 'SNS'], correctIndex: 0,
    explanation: 'サンプルのデータは、このブラウザだけに保存されます。本番の学習記録は変更しません。', learningPoint: 'サンプルの操作確認', sourceIds: [], sourceNote: '', status: 'published', version: 1, createdAt: now }];
  const topic: Topic = { id: createId(), ownerId:profile.id, title: proposal.title, subject: plan.subject, description: '操作確認用のサンプル。AIが作成した問題ではありません。',
    targetCount: originals.length, createdAt: now, planId: plan.id, ...(plan.testOnly ? { testOnly: true } : {}), ...(profile.role === 'student' ? { audienceUserId: profile.id } : {}) };
  const published = true;
  const questions: Question[] = originals.map(original => ({ ...original, id: createId(), ownerId:profile.id, topicId: topic.id, planId: plan.id,
    sourceIds: [], sourceNote: '操作確認用に用意されたサンプルです。教材やコメントからAIが生成した問題ではありません。',
    version: 1, createdAt: now, status: published ? 'published' : 'draft', needsReview: !published, publishedAt: published ? now : undefined,
    ...(plan.testOnly ? { testOnly: true } : {}), ...(profile.role === 'student' ? { audienceUserId: profile.id } : {}) }));
  const job: GenerationJob = { id: createId(), topicId: topic.id, planId: plan.id, turnId, proposalId, requestedBy: profile.id,
    status: 'review', targetCount: questions.length, generatedCount: questions.length, createdAt: now,
    ...(plan.testOnly ? { testOnly: true } : {}), ...(profile.role === 'student' ? { audienceUserId: profile.id } : {}) };
  return { data: { ...data, topics: [...data.topics, topic], questions: [...data.questions, ...questions], jobs: [...data.jobs, job] }, topic };
}
