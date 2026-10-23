import assert from 'node:assert/strict';
import test from 'node:test';
import { SERIES, validateLesson, validateCourse, validateApprovedLessons, applyReviews, hashLesson } from './schema.mjs';
import { buildCourse } from './build.mjs';

const fixture = (series = 'grammar', index = 0) => {
  const id = `${series}-lesson-${index}`;
  return { id, series, titleJa: '文脈から表現を選ぶ', levelTargets: ['B1'], goalJa: '状況の違いを読む。', conceptJa: '伝えたい内容を確認する。', commonTrapJa: '時間表現に注意する。', usageNotes: ['文脈を先に読む。'],
    examples: Array.from({ length: 4 }, (_, n) => ({ id: `${id}-ex${n + 1}`, text: `The school has ${n + 1} clubs.`, meaningJa: `部活動が${n + 1}つある。`, contextJa: '学校紹介' })),
    contrasts: Array.from({ length: 2 }, () => ({ leftEnglish: 'I live here.', rightEnglish: 'I am staying here.', noteJa: '居住と一時滞在の違い。' })),
    questions: Array.from({ length: 6 }, (_, n) => ({ id: `${id}-q${n + 1}`, type: 'context', scenarioJa: `場面${n + 1}`, prompt: 'I ___ here.', choices: ['live', 'lives', 'living', 'lived'].map(text => ({ text, feedbackJa: '文脈と主語を確認する。' })), correctIndex: 0, explanationJa: '現在の居住を述べる。', focusJa: '現在形' })),
    domainIds: ['education'], sourceReferences: [{ title: 'Fixture reference', url: 'https://example.org/grammar' }] };
};
const course = () => Object.keys(SERIES).flatMap(series => Array.from({ length: 12 }, (_, index) => fixture(series, index)));
const receipts = lessons => Object.keys(SERIES).map(series => ({ reviewer: `${series}-independent-reviewer`, reviewedAt: '2026-10-23T00:00:00.000Z', lessons: lessons.filter(lesson => lesson.series === series).map(lesson => ({ id: lesson.id, contentSha256: hashLesson(lesson), approved: true, issues: [] })) }));

test('initial course covers all three series without overlapping question/example identities', () => {
  assert.equal(validateCourse(course()).length, 36);
  assert.throws(() => validateCourse(course().slice(1)), /36 lessons/);
  const duplicate = course(); duplicate[35] = duplicate[0]; assert.throws(() => validateCourse(duplicate), /duplicate/);
});
test('questions require four distinct choices, a valid answer, scenario, and feedback', () => {
  for (const change of [
    x => { x.questions[0].correctIndex = 4; },
    x => { x.questions[0].choices[1].text = ' LIVE '; },
    x => { x.questions[0].choices.pop(); },
    x => { x.questions[0].scenarioJa = ''; },
    x => { x.questions[0].choices[0].feedbackJa = ''; },
    x => { x.questions[0].explanationJa = '正解は1です。'; },
  ]) { const lesson = fixture(); change(lesson); assert.throws(() => validateLesson(lesson)); }
});
test('independent review approves exact content and preserves each reviewer identity', () => {
  const lessons = course(), approved = applyReviews(lessons, receipts(lessons));
  assert.equal(approved.length, 36);
  assert.ok(approved.every(lesson => lesson.review.contentSha256 === hashLesson(lessons.find(source => source.id === lesson.id))));
  assert.deepEqual([...new Set(approved.map(lesson => lesson.review.reviewer))].sort(), ['grammar-independent-reviewer', 'prepositions-independent-reviewer', 'verbs-independent-reviewer']);
});
test('missing, duplicated, rejected or stale review cannot produce approved course', () => {
  const lessons = course();
  for (const change of [
    x => x[0].lessons.pop(),
    x => { x[0].lessons[1] = x[0].lessons[0]; },
    x => { x[0].lessons[0].approved = false; },
    x => { x[0].lessons[0].issues.push('Ambiguous answer.'); },
    x => { x[0].lessons[0].contentSha256 = '0'.repeat(64); },
  ]) { const r = receipts(lessons); change(r); assert.throws(() => applyReviews(lessons, r)); }
  const r = receipts(lessons); lessons[0].questions[0].choices[0].text = 'stay'; assert.throws(() => applyReviews(lessons, r), /stale/);
});
test('build defaults to unpublished drafts without audio and only saved-choice grading', () => {
  const draft = buildCourse(course());
  assert.deepEqual(draft.counts, { lessons: 36, examples: 144, questions: 216 });
  assert.equal(draft.reviewStatus, 'draft'); assert.equal(draft.publicationStatus, 'unpublished');
  assert.equal(draft.gradingPolicy, 'saved-choice-index-no-runtime-ai');
  assert.ok(draft.lessons.every(lesson => lesson.review.status === 'draft' && lesson.audio.status === 'not-generated'));
  const approved = buildCourse(course(), receipts(course()));
  assert.equal(approved.reviewStatus, 'approved'); assert.equal(approved.publicationStatus, 'unpublished');
});
test('preview and linkage require complete independent review evidence, not only an approved flag', () => {
  const lessons = course(), approved = applyReviews(lessons, receipts(lessons));
  assert.equal(validateApprovedLessons(approved).length, 36);
  for (const change of [
    x => { x[0].review.method = 'unreviewed'; },
    x => { delete x[0].review.reviewer; },
    x => { x[0].review.reviewer = '   '; },
    x => { delete x[0].review.reviewedAt; },
    x => { x[0].review.reviewedAt = 'today'; },
    x => { x[0].review.contentSha256 = '0'.repeat(64); },
  ]) { const copy = structuredClone(approved); change(copy); assert.throws(() => validateApprovedLessons(copy)); }
});
