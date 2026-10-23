#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReviewReceipts, validateSeries, VOLUME2_DOMAINS } from './schema.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(repo, 'content/reading-generated');
const args = process.argv.slice(2), reviewFiles = [];
for (let index = 0; index < args.length; index += 2) {
  if (args[index] !== '--review-file' || !args[index + 1]) throw new Error('Usage: node scripts/reading-batch/build-volume2.mjs [--review-file PATH ...]');
  reviewFiles.push(resolve(args[index + 1]));
}
const chunks = ['./volume2-foundations.mjs', './volume2-community.mjs', './volume2-culture.mjs'];
const parts = await Promise.all(chunks.map(chunk => import(chunk)));
const seriesId = 'reading-domains-volume2-v1';
let readings = validateSeries(parts.flatMap(part => part.readings), seriesId);
if (reviewFiles.length) readings = applyReviewReceipts(readings, await Promise.all(reviewFiles.map(async path => JSON.parse(await readFile(path, 'utf8')))), seriesId);
const reviewStatus = readings.every(reading => reading.review.status === 'approved') ? 'approved' : 'draft';
const file = 'volume2-v1.json';
const series = {
  schemaVersion: 1, seriesId, title: '分野で読む英語・広がる34編', reviewStatus,
  provenance: { contentOrigin: 'original-ai-authored', contentScope: 'fictional-stable-scenarios', externalGenerationCostUsd: 0 },
  questionPolicy: '4択の保存済み正解で採点します。回答時のAI呼び出しはありません。',
  difficultyPolicy: '級・CEFRは教材作成上の推定目安です。英検公式教材ではなく、TOEIC・TOEFL・IELTSとのスコア換算を示しません。',
  readings,
};
const descriptor = { id: seriesId, title: series.title, file, reviewStatus, publicationStatus: 'unpublished', passageCount: readings.length, questionCount: readings.reduce((sum, r) => sum + r.questions.length, 0), levels: ['2級', '準1級'], domainIds: VOLUME2_DOMAINS };
let currentIndex;
try { currentIndex = JSON.parse(await readFile(resolve(output, 'index.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; currentIndex = { schemaVersion: 1, series: [] }; }
if (currentIndex.schemaVersion !== 1 || !Array.isArray(currentIndex.series)) throw new Error('Existing reading index has an unsupported format.');
const index = { ...currentIndex, series: [...currentIndex.series.filter(existing => existing.id !== seriesId), descriptor] };
await mkdir(output, { recursive: true });
async function atomicJson(filename, data) {
  const target = resolve(output, filename), temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, target);
}
await atomicJson(file, series);
await atomicJson('index.json', index);
console.log(JSON.stringify({ reviewStatus, publicationStatus: 'unpublished', passages: readings.length, questions: descriptor.questionCount, words: readings.reduce((n, r) => n + r.wordCount, 0), output }));
