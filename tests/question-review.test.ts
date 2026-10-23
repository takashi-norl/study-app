import assert from 'node:assert/strict';
import test from 'node:test';
import { createDemoData } from '../src/lib/demo-data';
import { filterReviewRows, reviewDistribution, reviewRows, reviewStateLabel, reviewSummary } from '../src/lib/question-review';

test('review filters retain original topic order and numbers, including gaps for hidden questions', () => {
  const data = createDemoData();
  const original = data.questions[0];
  data.questions = [
    { ...original, id: 'first', prompt: 'First', status: 'draft' },
    { ...original, id: 'hidden', prompt: 'Hidden', status: 'archived' },
    { ...original, id: 'last', prompt: 'Last', needsReview: true },
  ];
  const rows = reviewRows(data);
  const filters = { topicId: original.topicId, query: '', needsReviewOnly: false, showArchived: false };
  assert.deepEqual(filterReviewRows(rows, filters).map(row => [row.question.id, row.number]), [['first', 1], ['last', 3]]);
  assert.deepEqual(filterReviewRows(rows, { ...filters, needsReviewOnly: true }).map(row => row.number), [3]);
  assert.deepEqual(filterReviewRows(rows, { ...filters, showArchived: true }).map(row => row.number), [1, 2, 3]);
  assert.deepEqual(rows.map(row => row.question.id), ['first', 'hidden', 'last']);
});

test('search checks evidence, choices, topic and source names with normalized multi-word matching', () => {
  const data = createDemoData();
  const original = data.questions[0];
  data.sources = [{ id: 'photo', name: '教科書１ページ.jpg', mimeType: 'image/jpeg', createdAt: original.createdAt }];
  data.questions = [{ ...original, prompt: 'Choose a word', choices: ['ＡＢＣ', 'DEF'], sourceIds: ['photo'], sourceNote: '写真の右側の説明', learningPoint: '単語' }];
  const rows = reviewRows(data);
  const filters = { topicId: 'all', query: 'abc 教科書1 写真', needsReviewOnly: false, showArchived: false };
  assert.equal(filterReviewRows(rows, filters).length, 1);
  assert.equal(filterReviewRows(rows, { ...filters, query: 'abc 不一致' }).length, 0);
  assert.equal(filterReviewRows(rows, { ...filters, query: '', topicId: 'absent' }).length, 0);
});

test('overview counts active drafts as usable and separates review warnings from publication metadata', () => {
  const data = createDemoData();
  const original = data.questions[0];
  data.questions = [
    { ...original, id: 'a', status: 'draft', needsReview: true, learningPoint: '同じポイント' },
    { ...original, id: 'b', status: 'approved', learningPoint: '同じポイント' },
    { ...original, id: 'c', status: 'published', learningPoint: '別のポイント' },
    { ...original, id: 'd', status: 'archived', needsReview: true, learningPoint: '非表示のポイント' },
  ];
  const rows = reviewRows(data);
  assert.deepEqual(reviewSummary(rows), { total: 4, active: 3, needsReview: 1, archived: 1, learningPoints: 2 });
  assert.deepEqual(reviewDistribution(rows, 'learningPoint'), [{ label: '同じポイント', count: 2 }, { label: '別のポイント', count: 1 }]);
  assert.equal(reviewStateLabel('published'), '保存済み');
});

test('source distribution counts a multi-source question once per source and handles missing references', () => {
  const data = createDemoData();
  const original = data.questions[0];
  data.sources = [
    { id: 'a', name: '写真A', mimeType: 'image/jpeg', createdAt: original.createdAt },
    { id: 'b', name: '写真B', mimeType: 'image/jpeg', createdAt: original.createdAt },
  ];
  data.questions = [
    { ...original, id: 'both', sourceIds: ['a', 'a', 'b'] },
    { ...original, id: 'one', sourceIds: ['a'] },
    { ...original, id: 'none', sourceIds: [] },
    { ...original, id: 'missing', sourceIds: ['missing'] },
  ];
  const rows = reviewRows(data);
  assert.equal(rows[0].sources.length, 2);
  assert.deepEqual(reviewDistribution(rows, 'source'), [
    { label: '写真A', count: 2 }, { label: '写真B', count: 1 },
    { label: '教材なし・相談から作成', count: 1 }, { label: '元の教材を取得できません', count: 1 },
  ]);
});

test('subject and source filters distinguish photos with the same filename and keep original numbers', () => {
  const data = createDemoData();
  const original = data.questions[0];
  data.sources = ['a', 'b'].map(id => ({ id, name: 'IMG.jpg', mimeType: 'image/jpeg', createdAt: original.createdAt }));
  data.questions = [
    { ...original, id: 'one', sourceIds: ['a'] },
    { ...original, id: 'two', sourceIds: ['b'] },
    { ...original, id: 'english', topicId: 'topic-english', sourceIds: ['a'] },
  ];
  const rows = reviewRows(data);
  const filters = { topicId: 'all', subject: '古文', sourceId: 'b', query: '', needsReviewOnly: false, showArchived: false };
  assert.deepEqual(filterReviewRows(rows, filters).map(row => [row.question.id, row.number]), [['two', 2]]);
  const kobunTopic = data.topics.find(topic => topic.id === original.topicId)!;
  kobunTopic.subject = '古文・古文単語（高校1年）';
  assert.deepEqual(filterReviewRows(reviewRows(data), filters).map(row => row.question.id), ['two']);
  assert.deepEqual(reviewDistribution(rows.slice(0, 2), 'source'), [
    { label: 'IMG.jpg（教材1）', count: 1 }, { label: 'IMG.jpg（教材2）', count: 1 },
  ]);
  assert.deepEqual(reviewDistribution([rows[1], rows[0], rows[1]], 'source', data.sources), [
    { label: 'IMG.jpg（教材2）', count: 2 }, { label: 'IMG.jpg（教材1）', count: 1 },
  ]);
});

test('same-prompt review detects exact repeats within each problem set without mistaking a published copy', () => {
  const data = createDemoData();
  const original = data.questions[0];
  data.questions = [
    { ...original, id: 'one', prompt: '古語「いと」の意味は？' },
    { ...original, id: 'two', prompt: '古語「いと」の 意味は？' },
    { ...original, id: 'copy', topicId: 'public-copy', prompt: '古語「いと」の意味は？' },
    { ...original, id: 'different', prompt: '古語「いと」の品詞は？' },
    { ...original, id: 'hidden', prompt: '古語「いと」の品詞は？', status: 'archived' },
  ];
  const filters = { topicId: 'all', query: '', needsReviewOnly: false, showArchived: false, samePromptOnly: true };
  assert.deepEqual(filterReviewRows(reviewRows(data), filters).map(row => row.question.id), ['one', 'two']);
  assert.deepEqual(filterReviewRows(reviewRows(data), { ...filters, showArchived: true }).map(row => row.question.id), ['one', 'two', 'different', 'hidden']);
});
