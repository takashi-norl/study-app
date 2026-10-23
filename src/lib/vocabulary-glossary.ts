import type { VerbForms } from './verb-forms';

export type GlossaryEntry = {
  id: string; term: string; aliases: string[]; meaning: string; definition: string; level: string;
  verbForms?: VerbForms;
  examples: { text: string; translation: string }[]; relatedIds: string[];
};
export type LookupRecord = {
  termId: string; lookupCount: number; lastLookedUpAt: string;
  status: 'looked-up' | 'practice' | 'known';
};
export type GlossaryPart = { text: string; entryId?: string };
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Longest whole phrase wins; original spelling, punctuation and spacing remain intact. */
export function matchGlossaryTerms(text: string, entries: GlossaryEntry[]): GlossaryPart[] {
  const aliases = new Map<string, string>();
  for (const entry of entries) for (const term of [entry.term, ...entry.aliases]) {
    const key = term.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key && !aliases.has(key)) aliases.set(key, entry.id);
  }
  if (!aliases.size) return [{ text }];
  const pattern = [...aliases.keys()].sort((a, b) => b.length - a.length)
    .map(term => term.split(' ').map(escape).join('\\s+')).join('|');
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}'’-])(?:${pattern})(?![\\p{L}\\p{N}'’-])`, 'giu');
  const parts: GlossaryPart[] = [];
  let offset = 0;
  for (const match of text.matchAll(matcher)) {
    if (match.index! > offset) parts.push({ text: text.slice(offset, match.index) });
    parts.push({ text: match[0], entryId: aliases.get(match[0].toLowerCase().replace(/\s+/g, ' ')) });
    offset = match.index! + match[0].length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts.length ? parts : [{ text }];
}
