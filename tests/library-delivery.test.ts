import assert from 'node:assert/strict';
import test from 'node:test';
import { requestLibraryDelivery, type LibraryDeliveryInput, type LibraryDeliveryResult } from '../src/lib/library-delivery';

const now = '2026-10-23T00:00:00.000Z';
const input = { topicId: 'source', learnerId: 'learner', projectName: '2学期中間テスト' };
function saved(body: LibraryDeliveryInput): LibraryDeliveryResult {
  const plan = { id: body.requestId, ownerId: body.learnerId, title: '古文単語26〜50', subject: '古文', goal: '復習', difficulty: '標準',
    dailyQuestionTarget: 10, sourceIds: [], version: 1, createdAt: now, updatedAt: now };
  return { plan, topic: { id: `${plan.id}-topic`, planId: plan.id, ownerId: body.learnerId, audienceUserId: body.learnerId,
    title: plan.title, subject: plan.subject, description: '練習用', targetCount: 25, createdAt: now }, deliveredCount: 25 };
}

test('a lost delivery response retries with the same request and normalized project until confirmed', async () => {
  const requests = new Map<string, string>();
  const calls: LibraryDeliveryInput[] = [];
  let ids = 0;
  const createId = () => `request-${++ids}`;
  await assert.rejects(requestLibraryDelivery(requests, 'parent', { ...input, projectName: ` ${input.projectName} ` }, async body => {
    calls.push(body); throw new TypeError('Failed to fetch');
  }, createId), /同じ依頼/);
  assert.equal(requests.size, 1);
  const result = await requestLibraryDelivery(requests, 'parent', input, async (body, signal) => {
    assert.equal(signal.aborted, false); calls.push(body); return saved(body);
  }, createId);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(ids, 1);
  assert.equal(result.plan.id, 'request-1');
  assert.equal(requests.size, 0);
  await requestLibraryDelivery(requests, 'parent', input, async body => saved(body), createId);
  assert.equal(ids, 2, 'a later intentional delivery starts a new request');
});

test('an invalid or unconfirmed delivery response retains the request for safe retry', async () => {
  for (const corrupt of [
    (result: LibraryDeliveryResult) => ({ ...result, deliveredCount: 0 }),
    (result: LibraryDeliveryResult) => ({ ...result, plan: { ...result.plan, ownerId: 'other' } }),
    (result: LibraryDeliveryResult) => ({ ...result, topic: { ...result.topic, ownerId: 'other' } }),
    (result: LibraryDeliveryResult) => ({ ...result, topic: { ...result.topic, planId: 'other' } }),
  ]) {
    const requests = new Map<string, string>();
    await assert.rejects(requestLibraryDelivery(requests, 'parent', input, async body => corrupt(saved(body)), () => 'same-request'), /保存の確認/);
    assert.equal(requests.size, 1);
    await requestLibraryDelivery(requests, 'parent', input, async body => {
      assert.equal(body.requestId, 'same-request'); return saved(body);
    }, () => { throw new Error('must reuse the request'); });
    assert.equal(requests.size, 0);
  }
});

test('delivery requests are scoped to actor, source, recipient and chosen project', async () => {
  const requests = new Map<string, string>();
  let ids = 0;
  for (const [actor, value] of [
    ['parent', input], ['parent2', input], ['parent', { ...input, topicId: 'other-source' }],
    ['parent', { ...input, learnerId: 'other-learner' }], ['parent', { ...input, projectName: '期末テスト' }],
  ] as const) {
    await assert.rejects(requestLibraryDelivery(requests, actor, value, async () => { throw new Error('unconfirmed'); }, () => `request-${++ids}`));
  }
  assert.equal(ids, 5);
  assert.equal(new Set(requests.values()).size, 5);
});

test('a blank project is omitted and overlong project names fail before delivery starts', async () => {
  const requests = new Map<string, string>();
  await requestLibraryDelivery(requests, 'parent', { ...input, projectName: '   ' }, async body => {
    assert.equal(Object.hasOwn(body, 'projectName'), false); return saved(body);
  });
  let sent = false;
  await assert.rejects(requestLibraryDelivery(requests, 'parent', { ...input, projectName: '名'.repeat(41) }, async body => {
    sent = true; return saved(body);
  }), /40文字/);
  assert.equal(sent, false);
  assert.equal(requests.size, 0);
});
