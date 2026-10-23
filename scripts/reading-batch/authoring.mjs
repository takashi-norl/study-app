// Shared source helpers for the second volume. The approved pilot is untouched.
export const makeReading = (level, domain, title, paragraphs, questions, vocabulary) => ({
  id: `reading-${level === '2級' ? 'grade2' : 'pre1'}-${domain}-002`,
  seriesId: 'reading-domains-volume2-v1', level,
  cefrEstimate: level === '2級' ? 'B1' : 'B2', domainIds: [domain], title,
  levelNote: '英検対策の学習目安です。公式問題・公式の級別認定・他試験とのスコア換算ではありません。',
  scenarioPolicy: '架空の人物・組織によるオリジナルの場面です。実在する研究・統計・時事報道の引用ではありません。',
  paragraphs: paragraphs.map((text, index) => ({ id: `p${index + 1}`, text })),
  questions: questions.map((question, index) => ({ id: `q${index + 1}`, ...question })), vocabulary,
  review: { status: 'draft', method: 'independent-ai-review-required' }, audio: { status: 'not-generated' },
});
export const q = (type, prompt, choices, correctIndex, explanationJa, paragraphId, quote) => ({ type, prompt, choices, correctIndex, explanationJa, evidence: [{ paragraphId, quote }] });
export const v = (term, meaningJa) => ({ term, meaningJa, linkPolicy: 'resolve-lemma-in-shared-catalog' });
