import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareFeedback } from '../../src/server/feedback';
import type { Profile } from '../../src/lib/types';
const profile: Profile = { id: 'learner', name: '本人',  workspaceId: 'beta' };
const raw = { requestId: 'c0bf864a-6530-4097-9d7e-f6801a3f69c0', category: '困った', message: ' 次へのボタンを見つけにくい ' };
const now = new Date('2026-10-23T04:00:00Z');
test('feedback contains only the submitted text, category and safe server metadata', () => {
  const event = prepareFeedback([], profile, raw, now)!;
  assert.equal(event.payload.message, raw.message.trim());
  assert.equal(event.actorId, profile.id);
  assert.deepEqual(Object.keys(event.payload).sort(), ['category', 'message', 'userId', 'version']);
  for (const extra of ['sourceIds','attempts','userId','version','email']) assert.throws(() => prepareFeedback([], profile, {...raw, [extra]: 'forged'}, now));
});
test('same feedback retry is idempotent while a changed body conflicts', () => {
  const event = prepareFeedback([], profile, raw, now)!;
  assert.equal(prepareFeedback([event], profile, raw, now), null);
  assert.throws(() => prepareFeedback([event], profile, {...raw, message: 'different'}, now), /送信済み/);
  assert.notEqual(prepareFeedback([event], {...profile,id:'other'}, raw, now)?.id, event.id);
});
test('daily feedback limits count unique own submissions, not other people or duplicate rows', () => {
  const event = prepareFeedback([], profile, raw, now)!;
  const rows = Array.from({length:5},(_,i)=>({...event,id:`feedback-${i}`}));
  assert.throws(() => prepareFeedback(rows, profile, raw, now), /1日5件/);
  assert.ok(prepareFeedback(rows, {...profile,id:'other'}, raw, now));
  assert.ok(prepareFeedback([rows[0],rows[0]], profile, raw, now));
  assert.ok(prepareFeedback(rows, profile, raw, new Date('2026-10-24T04:00:00Z')));
});
