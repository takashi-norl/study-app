import 'server-only';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeDomainPage, KnowledgeIndex, KnowledgeSentence, KnowledgeShard, KnowledgeTarget } from '@/lib/vocabulary-knowledge-generated-types';

const root = path.join(process.cwd(), 'content', 'vocabulary-knowledge', 'generated');
const cached = new Map<string, unknown>();
const shard = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 2);
const validId = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(value);
const normalizeTerm = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").trim().replace(/\s+/g, ' ');
async function readShard<T>(file: string): Promise<T | null> {
  if (cached.has(file)) {
    const value = cached.get(file); cached.delete(file); cached.set(file, value); return value as T;
  }
  try {
    const full = path.join(root, file);
    if ((await stat(full)).size > 4 * 1024 * 1024) throw new Error('Knowledge shard exceeds the runtime limit.');
    const value = JSON.parse(await readFile(full, 'utf8'));
    if (value.schemaVersion !== 1) throw new Error('Unknown knowledge shard schema.');
    if (cached.size >= 32) cached.delete(cached.keys().next().value!);
    cached.set(file, value); return value as T;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Read-only, bounded shards. Callers enforce their normal app/session authorization. */
export const vocabularyKnowledgeIndex = () => readShard<KnowledgeIndex>('index.json');
export async function vocabularyKnowledgeWord(id: string) {
  if (!validId(id)) return null;
  const data = await readShard<KnowledgeShard>(`words/${shard(id)}.json`);
  if (!data || !Object.hasOwn(data.words, id)) return null;
  const word = data.words[id];
  return { word, sentences: word.sentenceIds.flatMap(sentenceId => Object.hasOwn(data.sentences, sentenceId) ? [data.sentences[sentenceId]] : []) };
}
export async function vocabularyKnowledgeSentence(ownerId: string, sentenceId: string): Promise<KnowledgeSentence | null> {
  if (!validId(ownerId) || !validId(sentenceId)) return null;
  const data = await readShard<KnowledgeShard>(`words/${shard(ownerId)}.json`);
  const sentence = data && Object.hasOwn(data.sentences, sentenceId) ? data.sentences[sentenceId] : undefined;
  return sentence?.ownerId === ownerId ? sentence : null;
}
export async function vocabularyKnowledgeLookup(term: string): Promise<KnowledgeTarget[]> {
  if (!term || term.length > 240) return [];
  const normalized = normalizeTerm(term);
  const data = await readShard<{ terms: Record<string, KnowledgeTarget[]> }>(`terms/${shard(normalized)}.json`);
  return data && Object.hasOwn(data.terms, normalized) ? data.terms[normalized] : [];
}
export async function vocabularyKnowledgeDomain(domainId: string, page = 0): Promise<KnowledgeDomainPage | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(domainId) || !Number.isInteger(page) || page < 0) return null;
  const domain = (await vocabularyKnowledgeIndex())?.domains.find(item => item.id === domainId);
  if (!domain || page >= domain.pages) return null;
  return readShard<KnowledgeDomainPage>(`domains/${domainId}/${String(page).padStart(3, '0')}.json`);
}
export async function vocabularyKnowledgeDomainSentences(domainId: string, page = 0) {
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(domainId) || !Number.isInteger(page) || page < 0) return null;
  const domain = (await vocabularyKnowledgeIndex())?.domains.find(item => item.id === domainId);
  if (!domain || page >= domain.sentencePages) return null;
  return readShard<{ schemaVersion: 1; domainId: string; page: number; total: number; sentences: Pick<KnowledgeSentence, 'id' | 'ownerId' | 'text' | 'translation'>[] }>(`domains/${domainId}/sentences-${String(page).padStart(3, '0')}.json`);
}
