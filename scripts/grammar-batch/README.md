# English grammar and usage assets

The first course prioritizes Eiken and university entrance preparation: reading in context, choosing an appropriate expression, and writing accurately. Approximate A2–C1 tags describe the material; they are not official exam mappings or a completeness claim.

The course contains 36 independently reviewed lessons: 12 grammar, 12 preposition, and 12 core-verb/phrasal-verb lessons. Each has four bilingual examples, two contrasts and six four-choice questions with feedback for every option. Grading uses the saved answer index without a runtime model call. Sources are recorded per lesson; examples and questions are original.

## Build and validate

```sh
node scripts/grammar-batch/build.mjs \
  --review-file content/grammar-generated/grammar.review.json \
  --review-file content/grammar-generated/prepositions.review.json \
  --review-file content/grammar-generated/verbs.review.json
node scripts/grammar-batch/preview.mjs
node --import tsx scripts/grammar-batch/knowledge-links.ts --write
node --test scripts/grammar-batch/schema.test.mjs
node --import tsx --test scripts/grammar-batch/knowledge-links.test.ts
```

Building without review files produces a draft. Each review binds the independent reviewer and verdict to the exact normalized lesson hash. A missing, stale, rejected or duplicated verdict blocks an approved build. Source edits require new independent review.

`content/grammar-generated/series-v1.json` remains unpublished even when approved. Audio has not been generated. `outputs/grammar-series-preview.html` is a self-contained administrator preview; it neither stores student scores nor publishes content. It offers a lesson selector, a short concept view, one example at a time, and one test question at a time with explicit back/next controls.

The vocabulary sidecar links only reviewed examples and contrasts to the existing indexed lexicon. It preserves exact UTF-16 text offsets and hashes, known inflections and ambiguous candidates. Unknown words remain unlinked; a lexical link is not proof that every sense is interchangeable. Rebuild after adding vocabulary. Learning-mode highlighting and popovers remain future application work, not part of this data build.
