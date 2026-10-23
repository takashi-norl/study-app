# Generated vocabulary catalog

Only imported, AI-reviewed entries belong here. Private generation output and review/provenance records remain outside the app repository. The initial index is deliberately empty; the existing 100-word catalog and its saved recordings remain the default.

`index.json` uses this contract:

```json
{
  "schemaVersion": 2,
  "batches": [
    { "id": "grade3-001", "level": "3級", "title": "3級・セット1", "entryCount": 10, "file": "grade3-001.json" }
  ]
}
```

Each named file has `{ "schemaVersion": 2, "entries": [...], "audio": [...] }`. `audio` is optional. Batches contain 1–100 entries of one level: `3級`, `準2級`, `2級`, or `準1級`. IDs and filenames use lowercase letters, digits and hyphens. Batch ID `legacy-100` is reserved. Importers must reject duplicate IDs or lemmas across batches and the original catalog.

Entries retain the original `VocabularyEntry` fields and add exactly four authored `tests`, one for each mode: `meaning`, `word`, `context`, `usage`. Each test has `prompt`, four `choices: [{ text, meaning }]`, zero-based `correctIndex`, `explanation`, and `alternatives: [{ answer, explanation }]`. Explanations identify words or sentences, never numbered options: the app shuffles choice order. Choice meanings remain paired with their text and appear only after checking an answer. No runtime AI grading is used.

Optional audio metadata has `{ wordId, cacheKey, fileId, segments, voiceLabel }`. It references a saved private Drive file, never a public audio URL. The reader verifies the cache key against the exact word, three examples, voice and settings. Four ordered segments use IDs `word`, `example-1`, `example-2`, `example-3`. Private file IDs and cache keys are removed from browser responses. Generated audio playback reads this per-batch metadata without scanning the family event sheet. Generated entries cannot initiate paid audio requests from the preview UI or the existing fixed-catalog POST endpoint.

The admin page initially loads only the original 100 entries and a lightweight batch index. A new selection fetches one batch and presents ten-word study units. The server keeps at most four generated batches in memory. `next.config.ts` explicitly traces the generated JSON files for preview and audio routes.

Current preview scope: admin-only, no publication or learner progress persistence. Answers persist while switching ten-word units within the selected batch, and reset when choosing a different catalog batch. The glossary retains the original 100-word and foundation dictionary; generated words not in that dictionary do not yet have cross-batch lookup links or lookup history. This avoids links that cannot resolve; adding a lazy global dictionary is a separate step.
