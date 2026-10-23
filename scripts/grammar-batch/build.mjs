import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SERIES, validateCourse, applyReviews, hashLesson } from './schema.mjs';

export async function loadCourse() {
  return validateCourse((await Promise.all(Object.values(SERIES).map(async series => (await import(new URL(series.file, import.meta.url))).lessons))).flat());
}
export function buildCourse(lessons, receipts = []) {
  const checked = validateCourse(lessons), approved = receipts.length > 0;
  return {
    schemaVersion: 1, courseId: 'english-grammar-foundations-v1', titleJa: '英検・大学受験の英文法と表現',
    publicationStatus: 'unpublished', reviewStatus: approved ? 'approved' : 'draft',
    purposeJa: '英検と大学受験の読解・空欄補充・英作文に向け、文脈と使い分けを学ぶオリジナル教材。',
    levelNoteJa: '難易度は教材作成上の目安です。英検公式問題・公式出題範囲・合格保証ではありません。',
    gradingPolicy: 'saved-choice-index-no-runtime-ai',
    counts: { lessons: checked.length, examples: checked.reduce((n, item) => n + item.examples.length, 0), questions: checked.reduce((n, item) => n + item.questions.length, 0) },
    lessons: approved ? applyReviews(checked, receipts) : checked.map(lesson => ({ ...lesson, contentSha256: hashLesson(lesson), review: { status: 'draft', method: 'independent-ai-review-required' }, audio: { status: 'not-generated' } })),
  };
}
const writeChanged = async (file, value) => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try { if (await readFile(file, 'utf8') === text) return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(file, text); return true;
};
async function main() {
  const { values } = parseArgs({ options: { 'review-file': { type: 'string', multiple: true } }, strict: true, allowPositionals: false });
  const receipts = await Promise.all((values['review-file'] ?? []).map(async file => JSON.parse(await readFile(file, 'utf8'))));
  const course = buildCourse(await loadCourse(), receipts), directory = new URL('../../content/grammar-generated/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const changed = await writeChanged(new URL('series-v1.json', directory), course);
  await writeChanged(new URL('index.json', directory), { schemaVersion: 1, courseId: course.courseId, titleJa: course.titleJa, file: 'series-v1.json', reviewStatus: course.reviewStatus, publicationStatus: course.publicationStatus, counts: course.counts,
    series: Object.entries(SERIES).map(([id, config]) => ({ id, titleJa: config.titleJa, lessonIds: course.lessons.filter(lesson => lesson.series === id).map(lesson => lesson.id) })) });
  console.log(JSON.stringify({ ...course.counts, reviewStatus: course.reviewStatus, publicationStatus: course.publicationStatus, changed }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
