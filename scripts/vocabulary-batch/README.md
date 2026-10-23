# Resumable vocabulary text assets

This offline tool creates original learning material. It never calls ElevenLabs, changes a subscription, deploys the app, or modifies the existing100 entries. `ANTHROPIC_API_KEY` must already be supplied in the process environment. Do not put credentials in command arguments or asset files.

Targets are7500 unique single-word lemmas cumulatively:3級2100,準2級1500 additional,2級1500 additional,準1級2400 additional. These are approximate educational bands, not official Eiken lists. Existing100 are counted inside these totals. Multiword phrases are a separate future inventory. CEFR/domain tags support future packaging without claiming equivalent TOEIC/TOEFL/IELTS scores.

## Commands

```sh
node scripts/vocabulary-batch/build.mjs init --out /absolute/private/vocabulary-assets
node scripts/vocabulary-batch/build.mjs inventory --out /absolute/private/vocabulary-assets --max-calls 1
node scripts/vocabulary-batch/build.mjs build --out /absolute/private/vocabulary-assets --max-batches 1
node scripts/vocabulary-batch/build.mjs repair --out /absolute/private/vocabulary-assets --max-batches 1
node scripts/vocabulary-batch/build.mjs status --out /absolute/private/vocabulary-assets
node --test scripts/vocabulary-batch/builder.test.mjs
```

`--grade grade3|pre2|grade2|pre1` limits inventory/build/repair. `--model claude-sonnet-4-6` is the conservative default; explicitly priced alternatives are`claude-sonnet-5-5`, `claude-haiku-5-5`, and`claude-haiku-4-5-20251001`. Haiku5.5 requests must remain below100000 input tokens including a preflight margin; higher pricing tiers are refused. Recommended new work: Haiku5.5 for inventory, Sonnet5.5 for full entries and review. Always keep a request's selected model unchanged when replaying its saved response. `--budget-usd 100` is the hard shared text ceiling, not per command; lower values are permitted. The ledger counts all inventory, generation, review and repair calls. Full7500 completion is not promised within this ceiling. Five-entry batches can request up to20000 output tokens, reviews up to6000. Both responseusage and a maximum-price reservation are saved. There are no automatic provider retries.

`init`, `status`, and`salvage` make no network requests. Inventory calls propose at most100 lemmas and deduplicate against all saved words. Generation creates at most5 full cards. A separate fresh-context AI review checks each item; only approved items reach`approved/`. Rejected items stay saved with issues. `repair` makes a separately tracked paid revision, at most two per entry, then rechecks it independently. Truncated/structurally invalid provider responses remain in`raw/` without automatic paid retry. New generation uses low effort, independent review uses medium effort; thinking tokens remain included in the output/budget ceiling.

If a response is cut off, run`salvage --out /absolute/private/vocabulary-assets` before repairing. It reads exact, fully closed JSON objects from the saved prefix; it never guesses missing strings or brackets. Locally valid complete cards become review-only drafts in groups of at most5. Their original raw response and charge record stay unchanged. A subsequent`build`or`batch-prepare`reviews these drafts without regenerating them. Only incomplete/invalid cards remain eligible for explicit repair.

The5.5 models use `output_config.format` JSON output with the installed SDK's schema transformation, because their API rejects forced `tool_choice` requests. Older4.6 requests retain their original tool schema for saved-response replay. Both response formats undergo the same local schema and semantic checks. The token-count preflight includes the output schema.

Default one-call/one-batch synchronous commands are intentional smoke-test limits. Large production runs use the resumable Batch API commands below. Batch billing is50% of standard token prices ([official batch documentation](https://platform.claude.com/docs/en/build-with-claude/batch-processing), checked2026-10-23). Each submission reserves the maximum for at most500 requests atomically; if the remaining budget fits fewer requests, only that prefix is submitted. One provider batch may be outstanding at a time. Collecting results is safe to repeat and never resubmits generation.

```sh
# Prepare up to500 five-word generation/review requests locally (no key/network needed).
node scripts/vocabulary-batch/build.mjs batch-prepare --out /absolute/private/vocabulary-assets --model claude-sonnet-5-5 --max-batches 500
# Paid submission after token-count/budget preflight; returns the provider batch ID.
node scripts/vocabulary-batch/build.mjs batch-submit --out /absolute/private/vocabulary-assets --max-calls 500
# One status check/download, not an open-ended polling loop.
node scripts/vocabulary-batch/build.mjs batch-collect --out /absolute/private/vocabulary-assets
# After collection, repeat prepare to validate generations and queue independent reviews;
# after review collection, repeat prepare to approve assets and move to the next words.
node scripts/vocabulary-batch/build.mjs batch-prepare --out /absolute/private/vocabulary-assets --model claude-sonnet-5-5 --max-batches 500
# Prepare known rejected/invalid outputs for separately costed bounded repairs.
node scripts/vocabulary-batch/build.mjs batch-repair --out /absolute/private/vocabulary-assets --model claude-sonnet-5-5 --max-batches 500
```

Known schema/semantic failures are held for explicit`repair`or`batch-repair`; no paid retry is automatic. Oversized inventory responses are retained raw; up to200 candidates are checked individually, malformed/duplicate entries are skipped, and only the needed number of valid entries is accepted. This avoids charging again for a harmless model overrun.

## Files and consumption contract

- `frozen-100.json`: exact original entry snapshots and hashes; existing audio text remains unchanged.
- `manifest.json`: inventory, approximate grades, build state, per-entry attempts, frozen snapshot hash.
- `ledger.json`: durable maximum-cost reservation before each paid request; actual provider usage/cost afterwards.
- `raw/<request-id>.json`: original provider response saved before validation. A raw response can recover a crash between file persistence and ledger completion.
- `prepared/<request-id>.json`: immutable local provider request, not yet necessarily sent.
- `batches/<submission-id>.json`: aggregate reservation and provider batch ID/status.
- `batch-results/<request-id>.json`: original batch result envelope, including provider failures.
- `drafts/<batch-id>.json`: validated full entries awaiting independent review.
- `approved/<grade>/<batch-id>.json`: `{schemaVersion:1,batchId,entries:[{entry,review:{status:'approved',contentSha256,requestId,model,approvedAt},provenance}]}`.
- `rejected/<batch-id>.json`: rejected entries and concrete AI review issues.

Consumers must verify`review.contentSha256 === hashVocabularyEntry(entry)` using recursively sorted JSON keys (`schema.mjs`exports the helper), then unwrap`entry`. The entry retains legacy vocabulary fields and adds`tests`with all four authored modes, choice Japanese meanings, optional context alternatives, and metadata. The immutable approved data can be imported into application catalog shards or sent to the separate audio builder. No content changes are permitted after approval without another review. Full catalogs must not be shipped as one mobile response.

The exclusive`.text-build-lock`directory prevents competing processes from spending against one ledger. After a crash, verify the previous process is stopped before removing a stale lock. A pending/uncertain request with no saved raw response blocks all new spending. Do not delete its ledger record or blindly retry. An API error or timeout is not evidence that the request cost zero. Failed/expired/canceled batch items retain their maximum reservation until their billing/outcome has been explicitly reconciled; the tool does not assume zero cost.

Automatic validation plus AI review reduces errors but does not certify perfect linguistic accuracy. Every prompt requests original examples/definitions, unambiguous choices, exact verb inflections and concise Japanese. New approved assets remain separate from production until imported.
