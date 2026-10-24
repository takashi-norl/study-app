import type { LearningPlan, Profile, Question, StudyData, Topic } from './types';

/** Match the stored tag limits before saving a locally created demo or live plan. */
export function normalizePlanTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(tag => typeof tag !== 'string')) {
    throw new Error('タグは8個まで、1個40文字以内で入力してください。');
  }
  const trimmed = (value as string[]).map(tag => tag.trim());
  if (trimmed.some(tag => !tag || tag.length > 40)) throw new Error('タグは空欄にせず、1個40文字以内で入力してください。');
  const tags = [...new Set(trimmed)];
  if (tags.length > 8) throw new Error('タグは8個まで設定できます。');
  return tags;
}

/** Public content can use only this caller's adoption, never the public clone's private origin. */
export function ownPlanTagsForTopic(data: Pick<StudyData, 'plans'>, profile: Profile, topic: Topic): LearningPlan['tags'] {
  const plan = data.plans.find(item => item.ownerId === profile.id && (!item.testOnly || profile.accessLevel === 'superuser')
    && (topic.libraryPublished ? item.libraryTopicId === topic.id && !item.testOnly : item.id === topic.planId));
  return plan?.tags === undefined ? undefined : [...plan.tags];
}

/** Summarize only the already-authorized set, independently of the three sample excerpts. */
export function arrangementScopeSummary(topic: Pick<Topic, 'description'>, questions: readonly Pick<Question, 'learningPoint'>[]): string {
  const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
  const points = new Map<string, string>();
  for (const question of questions) {
    const point = question.learningPoint.trim().replace(/\s+/g, ' ');
    const key = point.normalize('NFKC').toLocaleLowerCase('ja');
    if (point && !points.has(key)) points.set(key, point);
  }
  const selected: string[] = [];
  let pointLength = 0;
  for (const point of points.values()) {
    const line = `・${clip(point, 100)}`;
    if (selected.length >= 40 || pointLength + line.length + 1 > 1200) break;
    selected.push(line); pointLength += line.length + 1;
  }
  return [
    `参照できる元の問題${questions.length}問から整理した範囲です。参考3問だけの学習項目に限定せず、次の範囲も出題案に反映してください。`,
    topic.description.trim() ? `問題集の説明（抜粋）：${clip(topic.description.trim(), 500)}` : '',
    selected.length ? `学習ポイント（${selected.length} / ${points.size}項目の抜粋）：\n${selected.join('\n')}` : '学習ポイントの記載はありません。',
    'この範囲の整理と参考3問は抜粋で、元の本文や試験範囲全体を網羅した資料ではありません。本文がない箇所や不足する条件を推測せず、作れる範囲と不足を相談してください。',
  ].filter(Boolean).join('\n');
}
