export type KnowledgeTarget = { nodeId: string; forms: string[] };
export type KnowledgeLink = { start: number; end: number; text: string; targets: KnowledgeTarget[]; ambiguous: boolean };
export type KnowledgeRelation = {
  id: string; type: 'contextual-synonym' | 'antonym' | 'contrast'; sourceSenseId: string;
  targetTerm: string; targetIds: string[]; scope: 'recall' | 'sentence'; evidenceIds: string[];
  noteJa: string; limitationsJa: string; replacementText?: string; source: 'authored-recall' | 'semantic-annotation';
};
export type KnowledgeSentence = {
  id: string; ownerId: string; kind: 'example' | 'recall'; text: string; translation?: string; contextLabel?: string;
  domainIds: string[]; scene?: string; register?: string; grammar: string[]; collocations: { phraseId: string; text: string }[];
  links: KnowledgeLink[]; wordIds: string[];
};
export type KnowledgeWord = {
  id: string; kind: 'word' | 'phrase'; term: string; meaning: string; definition?: string; level?: string;
  partOfSpeech?: string; batchId?: string; senseId: string; domainIds: string[];
  source: 'catalog' | 'foundation' | 'semantic-annotation'; aliases: { text: string; form: string }[];
  sentenceIds: string[]; mentionedIn: string[]; relations: KnowledgeRelation[];
  noteJa?: string; grammar?: string[]; evidenceIds?: string[];
};
export type KnowledgeShard = { schemaVersion: 1; words: Record<string, KnowledgeWord>; sentences: Record<string, KnowledgeSentence> };
export type KnowledgeDomainPage = {
  schemaVersion: 1; domainId: string; page: number; total: number;
  words: { id: string; term: string; meaning: string; level?: string; kind: 'word' | 'phrase'; batchId?: string }[];
};
export type KnowledgeIndex = {
  schemaVersion: 1; sourceDigest: string; sourcePolicy: string; shardStrategy: 'sha256-first-byte'; pageSize: 100;
  counts: { catalogWords: number; nodes: number; sentences: number; links: number; scopedRelations: number; phrases: number };
  domains: { id: string; labelJa: string; count: number; pages: number; sentenceCount: number; sentencePages: number }[];
  coverage: { annotatedWords: number; catalogWordsWithoutDomain: number; unknownDomainTags: string[]; unresolvedRelationTargets: number };
};
