export const TARGET_ALLOCATION = Object.freeze({
  schemaVersion: 1,
  baseTarget: 7500,
  totalTarget: 20000,
  expansionTarget: 12500,
  policy: 'Net new canonical units, not official exam word counts. Assign one primary collection only; reuse genre/exam tags without extra counts. Targets do not authorize filler or spending beyond the shared cap.',
  collections: [
    { id: 'eiken-1', titleJa: '英検1級を目安にした語彙', words: 3500, phrases: 0, priority: 1 },
    { id: 'advanced-reading', titleJa: '高度な読解・教養の語彙', words: 2500, phrases: 0, priority: 2 },
    { id: 'screen-everyday', titleJa: '映画・ドラマの日常会話', words: 1500, phrases: 1000, priority: 3 },
    { id: 'idioms-phrasal', titleJa: '汎用イディオム・句動詞', words: 0, phrases: 2000, priority: 4 },
    { id: 'genre-language', titleJa: 'ジャンルの語彙・表現', words: 1000, phrases: 500, priority: 5 },
    { id: 'teen-contemporary', titleJa: '現代の若者の会話表現', words: 0, phrases: 500, priority: 6 },
  ],
  genrePrimaryTargets: { 'crime-suspense': 250, romance: 250, urban: 250, 'science-fiction': 250, comedy: 250, action: 250 },
  pilot: { maxUnits: 20, maxPaidRequests: 10, audio: 'deferred', requiredChecks: ['independent-content-review', 'word-and-phrase-dedup', 'sense-and-register-accuracy', 'marginal-actual-cost'] },
  laterWaveMaxUnits: 1000,
  audioPolicy: 'Core 7,500 first. Expansion is text-first; new audio needs its own reservation against the same shared total.',
});

export function validateAllocation(plan = TARGET_ALLOCATION) {
  const total = plan.collections.reduce((sum, item) => sum + item.words + item.phrases, 0);
  if (total !== plan.expansionTarget || plan.baseTarget + total !== plan.totalTarget) throw new Error('Allocation does not reconcile to the total target.');
  if (new Set(plan.collections.map(item => item.id)).size !== plan.collections.length) throw new Error('Duplicate primary collections.');
  if (Object.values(plan.genrePrimaryTargets).reduce((a, b) => a + b, 0) !== plan.collections.find(item => item.id === 'genre-language')?.words + plan.collections.find(item => item.id === 'genre-language')?.phrases) throw new Error('Genre targets must be subdivisions, not extra units.');
  return plan;
}
