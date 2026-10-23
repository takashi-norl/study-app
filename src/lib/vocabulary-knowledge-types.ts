/** Offline-authored educational metadata. Relations are directional and evidence-scoped. */
export type KnowledgeTaxonomyItem = { id: string; labelJa: string; descriptionJa?: string };
export type VocabularyKnowledgeTaxonomy = {
  schemaVersion: 1;
  domains: KnowledgeTaxonomyItem[];
  scenes: KnowledgeTaxonomyItem[];
  registers: KnowledgeTaxonomyItem[];
  grammarTags: KnowledgeTaxonomyItem[];
};
export type KnowledgeRelation = {
  id: string;
  type: 'contextual-synonym' | 'antonym' | 'contrast';
  targetTerm: string;
  targetWordId?: string;
  scope: 'recall' | 'sentence';
  evidenceIds: string[];
  noteJa: string;
  limitationsJa: string;
  /** Full alternative sentence, only when actually authored for the referenced sentence. */
  replacementText?: string;
};
export type KnowledgeSentenceAnnotation = {
  sentenceId: string;
  domains: string[];
  scene: string;
  register: string;
  grammar: string[];
  collocations: { phraseId: string; text: string }[];
};
export type KnowledgeWordAnnotation = {
  wordId: string;
  domains: string[];
  sentenceAnnotations: KnowledgeSentenceAnnotation[];
  relations: KnowledgeRelation[];
};
export type KnowledgePhrase = {
  id: string;
  term: string;
  meaningJa: string;
  aliases: string[];
  grammar: string[];
  evidenceIds: string[];
  noteJa: string;
};
export type VocabularyKnowledgeAnnotations = {
  schemaVersion: 1;
  sourcePolicy: string;
  words: KnowledgeWordAnnotation[];
  phrases: KnowledgePhrase[];
};
