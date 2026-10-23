import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSampleAccess, prepareSampleAudio, createSampleProviderAudio, sampleAudioResponse, sampleAudioSpec } from '../../src/server/eiken-samples';
import catalog from '../../content/eiken-audio-samples.json';
import { getFamilyId } from '../../src/server/env';

test('authenticated members of every role may access curated content and audio', () => {
  const parent = { id: 'parent', name: 'Parent', role: 'parent' as const, familyId: getFamilyId() };
  assert.doesNotThrow(() => assertSampleAccess(parent));
  assert.doesNotThrow(() => assertSampleAccess({ ...parent, role: 'student' }));
  assert.throws(() => assertSampleAccess({ ...parent, familyId: 'other' }), { code: 'FORBIDDEN' });
});

test('six original samples have valid answers and writing word counts; only curated IDs can generate audio', () => {
  assert.equal(catalog.samples.length, 6);
  for (const sample of catalog.samples) {
    if (sample.skill === 'Writing') {
      const words = sample.modelAnswer!.trim().split(/\s+/).length;
      assert.ok(words >= sample.wordRange![0] && words <= sample.wordRange![1]);
      assert.throws(() => sampleAudioSpec(sample.id), { code: 'SAMPLE_NOT_FOUND' });
    } else {
      assert.equal(sample.choices!.length, 4);
      assert.ok(sample.correctIndex! >= 0 && sample.correctIndex! < 4);
      const spec = sampleAudioSpec(sample.id);
      assert.ok(spec.characters <= 2000);
      assert.equal(spec.body.model_id, 'eleven_v3');
      assert.doesNotMatch(JSON.stringify(spec.body), /正解|explanation|choices/);
      if (sample.skill === 'Listening') assert.equal(new Set(spec.body.inputs.map(turn => turn.voice_id)).size, 2);
    }
  }
  for (const id of ['../../.env', 'arbitrary text', '', 'grade1-listening']) assert.throws(() => sampleAudioSpec(id), { code: 'SAMPLE_NOT_FOUND' });
});

test('Safari ranges support first bytes, open ranges and suffixes without leaking file paths', async () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  for (const [range, expected] of [['bytes=0-1', [1,2]], ['bytes=3-', [4,5]], ['bytes=-2', [4,5]], ['bytes=0-999', [1,2,3,4,5]]] as const) {
    const response = sampleAudioResponse(data, range);
    assert.equal(response.status, 206);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...expected]);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
  for (const range of ['bytes=100-', 'bytes=3-1', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-1']) assert.equal(sampleAudioResponse(data, range).status, 416);
  const head = sampleAudioResponse(data, null, true);
  assert.equal(head.headers.get('Content-Length'), '5');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('sample provider uses both fixed voices without requiring voice-management permissions or paid retries', async () => {
  const original = globalThis.fetch; const oldKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = 'TEST_ONLY'; let paid = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      paid++;
      assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128');
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.inputs.length, 6);
      assert.equal(new Set(body.inputs.map((x: {voice_id:string}) => x.voice_id)).size, 2);
      return new Response('PRIVATE_PROVIDER_ERROR TEST_ONLY', { status: 500 });
    };
    await assert.rejects(() => createSampleProviderAudio(sampleAudioSpec('grade2-listening')), error => {
      assert.doesNotMatch(String(error), /PRIVATE_PROVIDER_ERROR|TEST_ONLY/); return true;
    });
    assert.equal(paid, 1);
  } finally { globalThis.fetch = original; if (oldKey === undefined) delete process.env.ELEVENLABS_API_KEY; else process.env.ELEVENLABS_API_KEY = oldKey; }
});


test('paid sample preparation rejects legacy parents and forged access levels before storage or provider access', async () => {
  const previous = process.env.ALLOWED_FAMILY_MEMBERS_JSON;
  const originalFetch = globalThis.fetch;
  process.env.ALLOWED_FAMILY_MEMBERS_JSON = JSON.stringify([
    { id: 'operator', name: 'Operator', email: 'takashi.oikawa@gmail.com', role: 'parent' },
    { id: 'manager', name: 'Member', email: 'member@example.com', role: 'parent' },
    { id: 'student', name: 'Student', email: 'student@example.com', role: 'student' },
  ]);
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Network must not be reached'); };
  try {
    for (const id of ['manager', 'student', 'unknown']) {
      await assert.rejects(() => prepareSampleAudio({ id, name: 'Member', role: 'parent', accessLevel: 'superuser', familyId: getFamilyId() }, 'grade2-listening'), { code: 'FORBIDDEN' });
    }
    await assert.rejects(() => prepareSampleAudio({ id: 'operator', name: 'Operator', role: 'parent', accessLevel: 'superuser', familyId: getFamilyId() }, 'not-curated'), { code: 'SAMPLE_NOT_FOUND' });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.ALLOWED_FAMILY_MEMBERS_JSON; else process.env.ALLOWED_FAMILY_MEMBERS_JSON = previous;
  }
});
