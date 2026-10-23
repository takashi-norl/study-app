#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readings as sourceReadings } from './pilot-content.mjs';
import { applyIndependentReview, validatePilot } from './schema.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(repo, 'content/reading-generated');
const args = process.argv.slice(2);
const reviewIndex = args.indexOf('--review-file');
if (args.length !== 0 && (args.length !== 2 || reviewIndex !== 0 || !args[1])) throw new Error('Usage: node scripts/reading-batch/build.mjs [--review-file /absolute/path/receipt.json]');
let readings = validatePilot(sourceReadings);
if (reviewIndex >= 0) readings = applyIndependentReview(readings, JSON.parse(await readFile(resolve(args[reviewIndex + 1]), 'utf8')));
const reviewStatus = readings.every(reading => reading.review.status === 'approved') ? 'approved' : 'draft';
const file = 'pilot-v1.json';
const series = {
  schemaVersion: 1, seriesId: 'reading-domains-pilot-v1', title: '分野で読む英語・最初の12編', reviewStatus,
  provenance: { contentOrigin: 'original-ai-authored', contentScope: 'fictional-stable-scenarios', externalGenerationCostUsd: 0 },
  questionPolicy: '4択の保存済み正解で採点します。回答時のAI呼び出しはありません。',
  difficultyPolicy: '級・CEFRは教材作成上の推定目安です。英検公式教材ではなく、TOEIC・TOEFL・IELTSとのスコア換算を示しません。',
  readings,
};
let existingSeries = [];
try {
  const previous = JSON.parse(await readFile(resolve(output, 'index.json'), 'utf8'));
  if (previous.schemaVersion !== 1 || !Array.isArray(previous.series)) throw new Error('Existing reading index has an unsupported format.');
  existingSeries = previous.series.filter(item => item.id !== series.seriesId);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const index = {
  schemaVersion: 1,
  series: [{ id: series.seriesId, title: series.title, file, reviewStatus, publicationStatus: 'unpublished', passageCount: readings.length, questionCount: readings.reduce((sum, r) => sum + r.questions.length, 0), levels: ['2級', '準1級'], domainIds: ['medical', 'travel', 'business', 'technology', 'politics', 'economics'] }, ...existingSeries],
};
await mkdir(output, { recursive: true });
async function atomicJson(filename, data) {
  const target = resolve(output, filename), temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, target);
}
// The index is written last, so readers never discover a nonexistent series file.
await atomicJson(file, series);
await atomicJson('index.json', index);
console.log(JSON.stringify({ reviewStatus, publicationStatus: 'unpublished', passages: readings.length, questions: index.series[0].questionCount, words: readings.reduce((n, r) => n + r.wordCount, 0), output }));
