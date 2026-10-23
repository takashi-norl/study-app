export type VerbForms = {
  base: readonly string[];
  past: readonly string[];
  pastParticiple: readonly string[];
  presentParticiple: readonly string[];
  thirdPersonSingular: readonly string[];
  note?: string;
};

// A checked, finite lexicon: never guess an unknown verb's conjugation.
// Order: past, past participle, -ing, third-person singular. Slash separates variants.
const inflections: Record<string, readonly [string, string, string, string]> = {
  avoid: ['avoided', 'avoided', 'avoiding', 'avoids'],
  afford: ['afforded', 'afforded', 'affording', 'affords'],
  contribute: ['contributed', 'contributed', 'contributing', 'contributes'],
  achieve: ['achieved', 'achieved', 'achieving', 'achieves'],
  admit: ['admitted', 'admitted', 'admitting', 'admits'],
  affect: ['affected', 'affected', 'affecting', 'affects'],
  appreciate: ['appreciated', 'appreciated', 'appreciating', 'appreciates'],
  arrange: ['arranged', 'arranged', 'arranging', 'arranges'],
  assume: ['assumed', 'assumed', 'assuming', 'assumes'],
  attract: ['attracted', 'attracted', 'attracting', 'attracts'],
  compare: ['compared', 'compared', 'comparing', 'compares'],
  confirm: ['confirmed', 'confirmed', 'confirming', 'confirms'],
  consider: ['considered', 'considered', 'considering', 'considers'],
  contain: ['contained', 'contained', 'containing', 'contains'],
  convince: ['convinced', 'convinced', 'convincing', 'convinces'],
  develop: ['developed', 'developed', 'developing', 'develops'],
  discover: ['discovered', 'discovered', 'discovering', 'discovers'],
  encourage: ['encouraged', 'encouraged', 'encouraging', 'encourages'],
  estimate: ['estimated', 'estimated', 'estimating', 'estimates'],
  expand: ['expanded', 'expanded', 'expanding', 'expands'],
  explore: ['explored', 'explored', 'exploring', 'explores'],
  improve: ['improved', 'improved', 'improving', 'improves'],
  include: ['included', 'included', 'including', 'includes'],
  involve: ['involved', 'involved', 'involving', 'involves'],
  maintain: ['maintained', 'maintained', 'maintaining', 'maintains'],
  obtain: ['obtained', 'obtained', 'obtaining', 'obtains'],
  participate: ['participated', 'participated', 'participating', 'participates'],
  prevent: ['prevented', 'prevented', 'preventing', 'prevents'],
  provide: ['provided', 'provided', 'providing', 'provides'],
  reduce: ['reduced', 'reduced', 'reducing', 'reduces'],
  undermine: ['undermined', 'undermined', 'undermining', 'undermines'],
  mitigate: ['mitigated', 'mitigated', 'mitigating', 'mitigates'],
  allocate: ['allocated', 'allocated', 'allocating', 'allocates'],
  implement: ['implemented', 'implemented', 'implementing', 'implements'],
  advocate: ['advocated', 'advocated', 'advocating', 'advocates'],
  deteriorate: ['deteriorated', 'deteriorated', 'deteriorating', 'deteriorates'],
  integrate: ['integrated', 'integrated', 'integrating', 'integrates'],
  facilitate: ['facilitated', 'facilitated', 'facilitating', 'facilitates'],
  exacerbate: ['exacerbated', 'exacerbated', 'exacerbating', 'exacerbates'],
  retain: ['retained', 'retained', 'retaining', 'retains'],
  diminish: ['diminished', 'diminished', 'diminishing', 'diminishes'],
  reinforce: ['reinforced', 'reinforced', 'reinforcing', 'reinforces'],
  fluctuate: ['fluctuated', 'fluctuated', 'fluctuating', 'fluctuates'],
  anticipate: ['anticipated', 'anticipated', 'anticipating', 'anticipates'],
  contradict: ['contradicted', 'contradicted', 'contradicting', 'contradicts'],
  eliminate: ['eliminated', 'eliminated', 'eliminating', 'eliminates'],
  preserve: ['preserved', 'preserved', 'preserving', 'preserves'],
  adapt: ['adapted', 'adapted', 'adapting', 'adapts'],
  justify: ['justified', 'justified', 'justifying', 'justifies'],
  compensate: ['compensated', 'compensated', 'compensating', 'compensates'],
  look: ['looked', 'looked', 'looking', 'looks'],
  focus: ['focused/focussed', 'focused/focussed', 'focusing/focussing', 'focuses'],
  label: ['labeled/labelled', 'labeled/labelled', 'labeling/labelling', 'labels'],
  combine: ['combined', 'combined', 'combining', 'combines'],
  damage: ['damaged', 'damaged', 'damaging', 'damages'],
  raise: ['raised', 'raised', 'raising', 'raises'],
  remain: ['remained', 'remained', 'remaining', 'remains'],
  trust: ['trusted', 'trusted', 'trusting', 'trusts'],
  claim: ['claimed', 'claimed', 'claiming', 'claims'],
  propose: ['proposed', 'proposed', 'proposing', 'proposes'],
  be: ['was/were', 'been', 'being', 'is'],
  take: ['took', 'taken', 'taking', 'takes'],
  go: ['went', 'gone', 'going', 'goes'],
  make: ['made', 'made', 'making', 'makes'],
  write: ['wrote', 'written', 'writing', 'writes'],
  read: ['read', 'read', 'reading', 'reads'],
  see: ['saw', 'seen', 'seeing', 'sees'],
  give: ['gave', 'given', 'giving', 'gives'],
  come: ['came', 'come', 'coming', 'comes'],
  begin: ['began', 'begun', 'beginning', 'begins'],
  speak: ['spoke', 'spoken', 'speaking', 'speaks'],
};
const phrases: Record<string, string> = {
  'look for': 'look',
  'take part in': 'take',
  'be able to': 'be',
  'focus on': 'focus',
  'be worried about': 'be',
  'make a mistake': 'make',
};
const notes: Record<string, string> = {
  label: 'labeled・labeling は主に米式、labelled・labelling は主に英式です。',
  focus: 'focused・focusing のほか、英式では focussed・focussing も使います。',
  be: 'be の現在形は主語によって am / are / is。過去形も was / were を使い分けます。',
  read: 'つづりは同じですが、原形は /riːd/、過去形・過去分詞は /red/ と読みます。',
};

export function getVerbForms(term: string): VerbForms | undefined {
  const base = Object.hasOwn(phrases, term) ? phrases[term] : term;
  if (!Object.hasOwn(inflections, base)) return undefined;
  const suffix = term.slice(base.length);
  const forms = inflections[base].map(group => group.split('/').map(form => `${form}${suffix}`));
  return {
    base: [term], past: forms[0], pastParticiple: forms[1],
    presentParticiple: forms[2], thirdPersonSingular: forms[3],
    ...(notes[base] ? { note: notes[base] } : {}),
  };
}

/** All conjugations resolve to one canonical term, including participles and phrase variants. */
export function getVerbAliases(term: string): string[] {
  const forms = getVerbForms(term);
  if (!forms) return [];
  const bePresent = phrases[term] === 'be' ? [`am${term.slice(2)}`, `are${term.slice(2)}`] : [];
  return [...new Set([
    ...forms.past, ...forms.pastParticiple, ...forms.presentParticiple, ...forms.thirdPersonSingular, ...bePresent,
  ])].filter(form => form !== term);
}
