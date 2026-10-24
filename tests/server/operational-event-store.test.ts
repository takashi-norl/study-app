import './legacy-production-runtime';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import { appendEvent, appendEvents, loadEvents, loadOperationsEvents, type StudyEvent } from '../../src/server/google-store';
import { betaMemberId, foldBetaMembership } from '../../src/server/beta-membership-schema';

const time = '2026-10-23T00:00:00.000Z';
const workspaceId = 'ledger-test-workspace';
const invitationId = 'b9b8f760-c607-4ed9-a18c-df188343aa9c';
const studyEvent: StudyEvent = { id: 'source-existing', type: 'source.created', actorId: 'operator', createdAt: time,
  payload: { id: 'source-existing', ownerId: 'operator', name: '本人の教材', mimeType: 'image/jpeg', createdAt: time } };
function operationalEvents(): StudyEvent[] {
  const id = betaMemberId('invited@example.com');
  return [
    { id: `beta-invitation:${invitationId}`, type: 'beta.invitation.created', actorId: 'operator', createdAt: time,
      payload: { id: invitationId, email: 'invited@example.com', name: 'Invited', tokenHash: 'a'.repeat(64), expiresAt: '2026-10-24T00:00:00.000Z' } },
    { id: `beta-member:${id}`, type: 'beta.member.registered', actorId: id, createdAt: time,
      payload: { id, invitationId, email: 'invited@example.com', name: 'Invited', googleSubject: 'verified-google-subject' } },
    { id: 'feedback:one', type: 'feedback.submitted', actorId: id, createdAt: time,
      payload: { userId: id, category: 'よかった', message: '使いやすい', version: '0.15.0' } },
    { id: `beta-revoked:member:${id}`, type: 'beta.access.revoked', actorId: 'operator', createdAt: time,
      payload: { kind: 'member', id } },
  ];
}
const row = (event: StudyEvent): unknown[] => [event.id, event.type, event.actorId, event.workspaceId ?? workspaceId, event.createdAt, JSON.stringify(event.payload)];

async function withStore(action: (state: {
  tabs: Map<string, unknown[][]>; writes: Array<{ method: string; url: string }>;
  fail: (target?: 'metadata'|'operations'|'create') => void; malformed: (target?: 'metadata'|'operations') => void;
  raceCreation: () => void;
}) => Promise<void>) {
  const environment = {
    WORKSPACE_ID: workspaceId, REGISTERED_ACCOUNTS_JSON: JSON.stringify([{ id: 'operator', name: 'Operator', email: 'takashi.oikawa@gmail.com', }]),
    NEXTAUTH_SECRET: 'unit-test-secret-with-at-least-thirty-two-characters', GOOGLE_CLIENT_ID: 'unit-client', GOOGLE_CLIENT_SECRET: 'unit-secret',
    GOOGLE_DRIVE_REFRESH_TOKEN: `unit-refresh-${Math.random()}`, GOOGLE_DRIVE_FOLDER_ID: 'unit-folder', GOOGLE_SHEETS_ID: 'unit-sheet', GOOGLE_SHEETS_EVENTS_TAB: 'Events',
  };
  const keys = [...Object.keys(environment), 'GOOGLE_DRIVE_OWNER_EMAIL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, environment); delete process.env.GOOGLE_DRIVE_OWNER_EMAIL;
  const token = mock.method(OAuth2Client.prototype, 'getAccessToken', async () => ({ token: 'UNIT_TEST_TOKEN' }));
  const tokenInfo = mock.method(OAuth2Client.prototype, 'getTokenInfo', async () => ({ aud: 'unit-client', scopes: ['https://www.googleapis.com/auth/drive.file'], expiry_date: Date.now()+60000 }));
  const tabs = new Map<string, unknown[][]>([['Events', [row(studyEvent)]]]);
  const writes: Array<{ method: string; url: string }> = [];
  let failing: string|undefined, malformed: string|undefined, race = false;
  const network = mock.method(globalThis, 'fetch', async (input: string|URL|Request, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET';
    assert.equal(url.origin, 'https://sheets.googleapis.com');
    if (method !== 'GET') writes.push({method, url: url.href});
    if (url.pathname === '/v4/spreadsheets/unit-sheet') {
      if (failing === 'metadata') return Response.json({error: 'denied'}, {status: 403});
      return Response.json(malformed === 'metadata' ? {} : {sheets: [...tabs.keys()].map(title => ({properties: {title}}))});
    }
    if (url.pathname === '/v4/spreadsheets/unit-sheet:batchUpdate') {
      if (failing === 'create') return Response.json({error: 'denied'}, {status: 403});
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, {requests: [{addSheet: {properties: {title: 'Events_Operations'}}}]});
      if (race) { race = false; tabs.set('Events_Operations', []); return Response.json({error: 'already exists'}, {status: 400}); }
      if (tabs.has('Events_Operations')) return Response.json({error: 'already exists'}, {status: 400});
      tabs.set('Events_Operations', []); return Response.json({replies: [{}]});
    }
    const range = decodeURIComponent(url.pathname.split('/values/')[1] ?? '');
    const tab = range.split('!')[0];
    assert.ok(['Events', 'Events_Operations'].includes(tab));
    if (method === 'POST') {
      assert.ok(tabs.has(tab));
      tabs.get(tab)!.push(...JSON.parse(String(init?.body)).values);
      return Response.json({updates:{updatedRows:1}});
    }
    if (tab === 'Events_Operations' && failing === 'operations') return Response.json({error:'denied'}, {status:403});
    if (tab === 'Events_Operations' && malformed === 'operations') return Response.json({values: 'invalid'});
    assert.ok(tabs.has(tab), 'a nonexistent tab must be detected by metadata without an invalid range read');
    return Response.json({values: structuredClone(tabs.get(tab))});
  });
  try { await action({tabs,writes,fail: target => {failing=target;},malformed: target => {malformed=target;},raceCreation: () => {race=true;}}); }
  finally {
    network.mock.restore(); token.mock.restore(); tokenInfo.mock.restore();
    for (const key of keys) {if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
  }
}

test('missing operations tab is read as empty without creating it or changing legacy Events', async () => withStore(async state => {
  const before = structuredClone(state.tabs.get('Events'));
  assert.deepEqual((await loadEvents()).map(event=>event.id), [studyEvent.id]);
  assert.deepEqual(state.tabs.get('Events'), before);
  assert.equal(state.tabs.has('Events_Operations'), false);
  assert.deepEqual(state.writes, []);
  await appendEvent({...studyEvent,id:'source-next'});
  assert.equal(state.tabs.get('Events')!.length, 2);
  assert.equal(state.tabs.has('Events_Operations'), false);
}));

test('renaming the workspace metadata preserves the existing fourth Sheets column and its exact value', async () => withStore(async state => {
  const before = structuredClone(state.tabs.get('Events'));
  const loaded = await loadEvents();
  assert.equal(loaded[0].workspaceId, workspaceId);
  assert.equal('familyId' in loaded[0], false);
  assert.deepEqual(state.tabs.get('Events'), before);
  await appendEvent({ ...studyEvent, id: 'source-next' });
  const saved = state.tabs.get('Events')![1];
  assert.deepEqual(saved.slice(0, 5), ['source-next', studyEvent.type, studyEvent.actorId, workspaceId, studyEvent.createdAt]);
}));

test('all four new event types use only the operations tab and replay registration and revocation in append order', async () => withStore(async state => {
  const before = structuredClone(state.tabs.get('Events'));
  const events = operationalEvents();
  await appendEvents(events);
  await appendEvent(events[2]); // Lost-response retry: one canonical feedback event.
  assert.deepEqual(state.tabs.get('Events'), before, 'the v0.14 reader still receives exactly its existing ledger');
  assert.ok(state.tabs.get('Events')!.every(saved => saved[1] === 'source.created'), 'no unknown event type reaches an old reader');
  assert.equal(state.writes.filter(write=>write.url.endsWith(':batchUpdate')).length, 1);
  const loaded = await loadEvents();
  assert.deepEqual(loaded.map(event=>event.id), [studyEvent.id, ...events.map(event=>event.id)]);
  const members = foldBetaMembership(loaded);
  assert.equal(members.members.size, 1);
  assert.equal(members.revokedMembers.has(events[1].actorId), true);
}));

test('a concurrent first writer may create the operations tab without dropping or duplicating an append', async () => withStore(async state => {
  state.raceCreation();
  await appendEvent(operationalEvents()[2]);
  assert.equal(state.tabs.get('Events_Operations')!.length, 1);
  assert.equal((await loadEvents()).filter(event=>event.type==='feedback.submitted').length, 1);
}));

test('metadata or operations read failures never become missing membership or missing revocation', async () => withStore(async state => {
  state.tabs.set('Events_Operations', operationalEvents().map(row));
  for (const target of ['metadata','operations'] as const) {
    state.fail(target); await assert.rejects(()=>loadEvents(), {code:'GOOGLE_ACCESS_DENIED'}); state.fail();
    state.malformed(target); await assert.rejects(()=>loadEvents(), {code:'INVALID_EVENT_LOG'}); state.malformed();
  }
  assert.deepEqual(state.writes, []);
}));

test('invalid or misplaced operational rows fail closed instead of altering study data', async () => withStore(async state => {
  state.tabs.set('Events_Operations', [row(studyEvent)]);
  await assert.rejects(()=>loadEvents(), {code:'INVALID_EVENT_LOG'});
  state.tabs.set('Events_Operations', [row({...operationalEvents()[2],actorId:'forged'})]);
  await assert.rejects(()=>loadEvents(), {code:'INVALID_EVENT_LOG'});
  state.tabs.set('Events_Operations', []);
  state.tabs.get('Events')!.push(row(operationalEvents()[2]));
  await assert.rejects(()=>loadEvents(), {code:'INVALID_EVENT_LOG'});
}));

test('invalid or mixed batches do not create a tab, and a denied create cannot append anything', async () => withStore(async state => {
  await assert.rejects(()=>appendEvents([studyEvent,operationalEvents()[2]]), {code:'MIXED_EVENT_LEDGERS'});
  await assert.rejects(()=>appendEvent({...operationalEvents()[2],actorId:'forged'}), {code:'INVALID_FEEDBACK'});
  assert.deepEqual(state.writes, []);
  state.fail('create');
  await assert.rejects(()=>appendEvent(operationalEvents()[2]), {code:'GOOGLE_ACCESS_DENIED'});
  assert.equal(state.tabs.has('Events_Operations'), false);
  assert.equal(state.tabs.get('Events')!.length, 1);
  assert.equal(state.writes.length, 1);
}));


test('membership and feedback can read operations without reading the private study ledger', async () => withStore(async state => {
  state.tabs.delete('Events');
  state.tabs.set('Events_Operations', operationalEvents().map(row));
  assert.equal((await loadOperationsEvents()).length, 4);
  assert.deepEqual(state.writes, []);
}));
