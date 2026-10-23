import { requireProfile } from '@/server/auth';
import { api, readJson } from '@/server/http';
import { loadEvents } from '@/server/google-store';
import { glossaryEntries } from '@/server/vocabulary-glossary-catalog';
import { foldVocabularyLookups, saveVocabularyLookup } from '@/server/vocabulary-lookups';
import { vocabularyLookupSchema } from '@/server/vocabulary-lookup-schemas';

// This catalogue is an admin-only preview until explicitly published.
export async function GET() { return api(async () => {
  const { profile } = await requireProfile('parent');
  return { records: foldVocabularyLookups(await loadEvents(), profile.id) };
}); }
export async function POST(request: Request) { return api(async () => {
  const { profile } = await requireProfile('parent');
  return saveVocabularyLookup(profile.id, await readJson(request, vocabularyLookupSchema), new Set(glossaryEntries.map(entry => entry.id)));
}); }
