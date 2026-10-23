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
  query: string;
  needsReviewOnly: boolean;
  showArchived: boolean;
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

export function filterReviewRows(rows: ReviewRow[], filters: ReviewFilters): ReviewRow[] {
  const terms = normalized(filters.query).trim().split(/\s+/).filter(Boolean);
  return rows.filter(({ question, topic, sources }) => {
    if (filters.topicId !== 'all' && question.topicId !== filters.topicId) return false;
    if (!filters.showArchived && question.status === 'archived') return false;
    if (filters.needsReviewOnly && !question.needsReview) return false;
    const searchable = normalized([
      question.prompt, ...question.choices, question.explanation, question.learningPoint,
      question.sourceNote, topic?.title ?? '', topic?.subject ?? '', ...sources.map(source => source.name),
    ].join(' '));
    return terms.every(term => searchable.includes(term));
  });
}

export type ReviewGrouping = 'learningPoint' | 'source' | 'subject';
export interface ReviewDistribution { label: string; count: number }

/** Count the active questions once in each relevant group, without changing review order. */
export function reviewDistribution(rows: ReviewRow[], grouping: ReviewGrouping): ReviewDistribution[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.question.status === 'archived') continue;
    const labels = grouping === 'learningPoint' ? [row.question.learningPoint.trim() || 'ポイント未設定']
      : grouping === 'subject' ? [row.topic?.subject || '科目未設定']
      : row.sources.length ? [...new Set(row.sources.map(source => source.name))]
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
