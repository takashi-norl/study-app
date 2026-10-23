import 'server-only';
import { createHash } from 'node:crypto';
import type { LookupRecord } from '@/lib/vocabulary-glossary';
import { appendEvents, loadEvents, type StudyEvent } from './google-store';
import { ApiError } from './config';
import { vocabularyLookupSchema } from './vocabulary-lookup-schemas';

/** Owner is always the authenticated actor; managers do not receive another person's lookup history. */
export function foldVocabularyLookups(events: StudyEvent[], ownerId: string): LookupRecord[] {
  const records = new Map<string, LookupRecord>();
  const seen = new Set<string>();
  for (const event of events) {
    if (event.type !== 'vocabulary.lookup' || event.actorId !== ownerId) continue;
    const input = vocabularyLookupSchema.safeParse(event.payload);
    if (!input.success || seen.has(input.data.requestId)) continue;
    const { termId, action, requestId } = input.data;
    seen.add(requestId);
    const previous = records.get(termId);
    if (action !== 'lookup' && !previous) continue;
    records.set(termId, {
      termId, lookupCount: (previous?.lookupCount ?? 0) + (action === 'lookup' ? 1 : 0),
      lastLookedUpAt: action === 'lookup' ? event.createdAt : previous!.lastLookedUpAt,
      status: action === 'lookup' ? previous?.status === 'practice' ? 'practice' : 'looked-up' : action,
    });
  }
  return [...records.values()].sort((a, b) => b.lastLookedUpAt.localeCompare(a.lastLookedUpAt));
}

type Store = { load: typeof loadEvents; append: typeof appendEvents; now: () => Date };
export async function saveVocabularyLookup(ownerId: string, raw: unknown, validIds: Set<string>, overrides: Partial<Store> = {}) {
  const input = vocabularyLookupSchema.parse(raw);
  if (!validIds.has(input.termId)) throw new ApiError(404, 'この言葉の教材はまだありません。', 'GLOSSARY_NOT_FOUND');
  const store: Store = { load: loadEvents, append: appendEvents, now: () => new Date(), ...overrides };
  const before = await store.load();
  const previous = before.find(event => event.actorId === ownerId && event.type === 'vocabulary.lookup' && event.payload.requestId === input.requestId);
  if (previous && (previous.payload.termId !== input.termId || previous.payload.action !== input.action)) {
    throw new ApiError(409, '送信内容が変わっています。画面を開き直してください。', 'REQUEST_CONFLICT');
  }
  if (!previous) {
    if (input.action !== 'lookup' && !foldVocabularyLookups(before, ownerId).some(record => record.termId === input.termId)) {
      throw new ApiError(409, '先にこの言葉を開いて確認してください。', 'LOOKUP_REQUIRED');
    }
    const id = `vocabulary-lookup:${createHash('sha256').update(ownerId).digest('hex').slice(0, 24)}:${input.requestId}`;
    await store.append([{ id, actorId: ownerId, type: 'vocabulary.lookup', createdAt: store.now().toISOString(), payload: input }]);
  }
  const record = foldVocabularyLookups(await store.load(), ownerId).find(record => record.termId === input.termId);
  if (!record) throw new ApiError(502, '履歴の保存を確認できませんでした。再試行してください。', 'LOOKUP_SAVE_FAILED');
  return { record };
}
