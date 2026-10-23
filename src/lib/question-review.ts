import type { Question, QuestionStatus, SourceDocument, StudyData, Topic } from './types';

export interface ReviewRow {
  question: Question;
  topic: Topic | undefined;
  /** Number in the original topic, including hidden questions. Filters never renumber it. */
  number: number;
  sources: SourceDocument[];
}

export interface ReviewFilters {
  topicId: string;
  subject?: string;
  sourceId?: string;
  query: string;
  needsReviewOnly: boolean;
  showArchived: boolean;
  samePromptOnly?: boolean;
}

export function reviewRows(data: StudyData): ReviewRow[] {
  const topics = new Map(data.topics.map(topic => [topic.id, topic]));
  const sources = new Map(data.sources.map(source => [source.id, source]));
  const counts = new Map<string, number>();
  return data.questions.map(question => {
    const number = (counts.get(question.topicId) ?? 0) + 1;
    counts.set(question.topicId, number);
    return {
      question, topic: topics.get(question.topicId), number,
      sources: [...new Set(question.sourceIds)].flatMap(id => sources.get(id) ?? []),
    };
  });
}

const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ja');
export const reviewSubject = (subject?: string) => subject?.startsWith('古文') ? '古文' : subject;

export function filterReviewRows(rows: ReviewRow[], filters: ReviewFilters): ReviewRow[] {
  const terms = normalized(filters.query).trim().split(/\s+/).filter(Boolean);
  const scoped = rows.filter(({ question, topic }) => {
    if (filters.topicId !== 'all' && question.topicId !== filters.topicId) return false;
    if (filters.subject && filters.subject !== 'all' && reviewSubject(topic?.subject) !== filters.subject) return false;
    if (filters.sourceId && filters.sourceId !== 'all' && !question.sourceIds.includes(filters.sourceId)) return false;
    if (!filters.showArchived && question.status === 'archived') return false;
    return true;
  });
  const repeated = filters.samePromptOnly ? repeatedReviewPromptIds(scoped) : undefined;
  return scoped.filter(({ question, topic, sources }) => {
    if (filters.needsReviewOnly && !question.needsReview) return false;
    if (repeated && !repeated.has(question.id)) return false;
    const searchable = normalized([
      question.prompt, ...question.choices, question.explanation, question.learningPoint,
      question.sourceNote, topic?.title ?? '', topic?.subject ?? '', ...sources.map(source => source.name),
    ].join(' '));
    return terms.every(term => searchable.includes(term));
  });
}

/** Exact prompt matches within one topic, ignoring formatting; this does not judge semantic similarity. */
export function repeatedReviewPromptIds(rows: ReviewRow[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const { question } of rows) {
    const prompt = normalized(question.prompt).replace(/\s+/g, '');
    if (!prompt) continue;
    const key = JSON.stringify([question.topicId, prompt]);
    groups.set(key, [...(groups.get(key) ?? []), question.id]);
  }
  return new Set([...groups.values()].filter(ids => ids.length > 1).flat());
}

export type ReviewGrouping = 'learningPoint' | 'source' | 'subject';
export interface ReviewDistribution { label: string; count: number }

/** Count the active questions once in each relevant group, without changing review order. */
export function reviewDistribution(rows: ReviewRow[], grouping: ReviewGrouping, sourceOrder?: SourceDocument[]): ReviewDistribution[] {
  const counts = new Map<string, number>();
  const sources = [...new Map([...(sourceOrder ?? []), ...rows.flatMap(row => row.sources)].map(source => [source.id, source])).values()];
  const sourceLabels = new Map(sources.map((source, index) => [source.id,
    sources.filter(item => item.name === source.name).length > 1 ? `${source.name}（教材${index + 1}）` : source.name]));
  for (const row of rows) {
    if (row.question.status === 'archived') continue;
    const labels = grouping === 'learningPoint' ? [row.question.learningPoint.trim() || 'ポイント未設定']
      : grouping === 'subject' ? [row.topic?.subject || '科目未設定']
      : row.sources.length ? [...new Set(row.sources.map(source => sourceLabels.get(source.id)!))]
      : [row.question.sourceIds.length ? '元の教材を取得できません' : '教材なし・相談から作成'];
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

export function reviewSummary(rows: ReviewRow[]) {
  const active = rows.filter(row => row.question.status !== 'archived');
  return {
    total: rows.length,
    active: active.length,
    needsReview: active.filter(row => row.question.needsReview).length,
    archived: rows.length - active.length,
    learningPoints: reviewDistribution(active, 'learningPoint').length,
  };
}

export function reviewStateLabel(status: QuestionStatus): string {
  return { draft: '下書き', approved: '確認済み', published: '保存済み', archived: '非表示' }[status];
}
