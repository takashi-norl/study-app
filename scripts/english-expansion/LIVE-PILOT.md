# First expansion pilot: 20 items, text only

This implementation is ready for offline review; **live activation is not installed**.
It never starts a worker, buys credits, creates audio, or publishes to the application.
The CLI sends at most one explicitly supplied work file. Twenty registered units
and ten total generation/review submissions are hard limits, including failed calls.
Changing a request ID cannot authorize a repeat for the same stage and unit.

## One shared budget and a one-way handoff

The original phase-one caps remain USD100 text and USD400 audio. They are not an
additional allowance beside expansion. `budget.mjs` retains every original and
retry audio reservation and every unknown text outcome. The total limit remains
USD500 and JPY100,000 using a conservative planning conversion of 180JPY/USD plus
a 10% buffer. This is a planning bound, not a quoted exchange or tax rate.

Funding liabilities use `max(text usage, text prepayments) + max(audio usage,
audio prepayments)`, so a confirmed ElevenLabs top-up funds its audio pool without
being added again to the same consumed credits. Include **all confirmed payment
obligations**, including the already confirmed USD100 ElevenLabs purchase, in
the integration receipt. An observed yen charge above the planning allowance
closes the gate. Unknown provider outcomes retain their full reservations.

`shared-spending-fence.mjs` supplies the exclusive lifetime lock. The proposed
phase-one worker holds it until its child commands close; a standalone run wrapper
must acquire the same lock. Phase two holds it through quote, reservation, request,
raw capture, accounting and review persistence. A missing, damaged or occupied
lock is never stolen automatically.

Before the first phase-two reservation, `phase-two-handoff.json` is durably saved
in the runtime directory. The proposed phase-one launch and run wrappers refuse
paid work once this exists. **Do not remove it to restart phase one.** Individual
phase-one caps alone would otherwise allow later overspending after expansion
uses the shared remainder. Resuming phase-one paid repair requires a separately
reviewed migration of its reservation paths to the common budget plus an explicit
baseline update; it is not implemented here. All scheduled/automated paid phase-one
launches must use the reviewed wrappers. A direct legacy provider CLI outside
those wrappers is not an approved operational path after handoff.

## Activation proof (not a boolean switch)

`activation.mjs` requires `<runtime>/shared-spending-integration.json`. No template
or receipt is auto-created, and no credentials are read before the filesystem gate.
The receipt must contain:

- `schemaVersion:1`, the exported fence `protocol`, `enabled:true`,
  `scope:"phase-two-initial-pilot"`, `textOnly:true`, independent `reviewedBy`
  and ISO `reviewedAt`; `pilot:{maxUnits:20,maxPaidRequests:10}`.
- `paths` binding absolute `phaseOneOutput`, `runtimeDirectory`, `output`,
  and `<runtime>/shared-spending.lock` as `sharedLockDirectory`.
- `files`: exact `{id,sha256}` for **every** result of `integrationFiles(runtime)`.
  This binds both actual phase-one entry points and all spending/content modules.
  A reviewed path cannot be a symlink; any changed file makes approval stale.
- `pricingPolicySha256: PRICING_POLICY_SHA256`,
  `expenseCoverage:"reviewed-ledgers-plus-bounded-historical-allowance"`, and
  the exact reviewed `historicalCommitments` receipt described below. This covers
  prior uncertainty with fixed reserves; it does not claim all bills are settled.
- The complete `cashPurchases` array with
  `{id,provider,fundingPool,amountUsdPreTax,chargedJpy?}` records. Confirmed audio
  prepayments must include at least the USD100 already recorded in the audit.
- `inventory:{source,review}`: source `{schemaVersion:1,id,createdBy,seeds}`
  containing 1–20 `validateSeed` records. Review has `schemaVersion:1`, exact
  canonical `sourceSha256`, a different `reviewedBy`, ISO `reviewedAt`, and one
  `{id,approved:true,issues:[]}` verdict for **every** seed.
- `canonicalAudit:{proposal,review}` in the format below.

This receipt is to be assembled by the independent integration reviewer after
the stopped runtime patch is actually installed. Hashing proposed copies and
claiming the unchanged runtime is integrated is invalid. Reading the receipt
with `verifyIntegration(options)` is safe and performs no network call.

## Count lexical families without deleting useful senses

`baseLexicalSnapshot(registry)` hashes every base card's stable ID, normalized
lemma, aliases and full source-content hash. A canonical proposal has
`{schemaVersion:1,id,createdBy,baseSnapshotSha256,groups}`. Each group has
`{canonicalLemma,memberIds:[...],reasonJa}` with at least two current card IDs.
Review has `{schemaVersion:1,sourceSha256,reviewedBy,reviewedAt,approved:true,
issues:[],coverage:"all-base-lexical-families"}`. Author and reviewer must differ.

This is a full-coverage audit of the finished base, not a claim that spelling alone
identifies a synonym. In particular, `analog` adjective / `analogue` noun and
`annex` verb / `annexe` noun can retain separate paid cards and learner IDs while
each reviewed lexical family counts once. Both spellings remain dedup-reserved.
The completed-base audit identified seven families, including cross-grade plural,
comparative and participle cards. Those 7,500 cards therefore represent 7,493
canonical families until seven distinct replacement words are completed.

Phase one now uses `vocabulary-batch/canonical-policy.mjs` through `catalogCounts`
and `baseCount`. Its separate `catalog-family.mjs` tool applies independently
reviewed seed/content/review hashes as metadata under the stopped shared fence
and text lock. Every paid sense card stays public; one representative consumes
one slot in its original grade. The seven audited overlaps free seven grade2
slots, without changing `GRADES` or bypassing the existing curated importer quota.
The metadata application must precede the replacement imports. It never edits
original content, status, learner IDs, audio or billing evidence.

After the replacements finish, rebuild and independently approve the full
`baseLexicalSnapshot` audit: the earlier snapshot is stale by design. The live
gate requires exactly 7,500 **reviewed canonical families** and every retained
source card approved/preserved; it permits the additional sense cards. Both the
phase-one policy modules and the final snapshot are bound to activation. Disposed
and held assets remain in dedup and spending but not the base count.

## Provider policy and saved work

The initial provider is `claude-sonnet-5-5`, standard synchronous Messages,
`service_tier:"standard_only"`, `inference_geo:"global"`, no tools or cache writes,
and SDK retries disabled. Official rates checked on 2026-10-24 are input USD2,
output USD10, cache-read USD0.10 per million tokens. See the
[official pricing page](https://platform.claude.com/docs/en/about-claude/pricing).
Verification expires after seven days. Model availability and token counting are
checked before paid submission. Counted input is limited to 25k tokens; the quote
conservatively reserves a full 50k input ceiling plus the full output limit.
Generation reserves up to20k output tokens; independent review up to8k. Reasoning
is already included in billed `output_tokens` and must not be added twice.

Structured output uses the SDK's JSON-schema helper and local strict validation;
raw `.create()` output is saved before parsing. See
[structured-output documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
Sonnet5.5 adaptive thinking is left supported; generation uses low effort and
review medium effort, with full output reservation. The
[thinking documentation](https://platform.claude.com/docs/en/build-with-claude/thinking)
explains why hidden thinking can still consume billed output.

Create a private work JSON with `generationWork(approvedSeeds, {id,createdAt})`
for at most five seeds. IDs and dates are bound into the exact provider prompt.
The compact output is expanded deterministically into one sense, three examples
and four authored MCQ modes. There is no runtime AI grading. Build review work
with `reviewWork(savedDraftUnits, {id,createdAt})`; it uses fresh context and checks
every complete card. Reviews bind full content SHA256. Approved private assets
are immutable; rejected cards keep their raw, cost and review issues.

After all activation steps, an operator can send **one** reviewed work file with:

```sh
node scripts/english-expansion/live-pilot.mjs \
  --out /absolute/private/expansion-output \
  --phase-one /absolute/private/vocabulary-assets-2026 \
  --runtime /private/tmp/hibi-vocabulary-build \
  --work /absolute/private/work/generation-001.json \
  --send-reviewed-request
```

The existing private credential loader must supply `ANTHROPIC_API_KEY` in the
child environment; never put it into JSON, arguments, stdout or this document.
The actual implementation must first pass independent code/integration review.

`requests/<id>/work.json`, `request.json` and a full reservation precede network
submission; a `requested` marker is fsynced before SDK entry. `response.json`
precedes cost reconciliation and content parsing. Missing raw after submission
is uncertain and **cannot be automatically resent**. Saved complete raw replays
without another API call. Even content/schema failure retains known actual cost.
Unexpected pricing or a charge above reservation creates a blocking accounting hold.

## What remains before scaling

Install/review the stopped phase-one patch, finish/audit 7,500 canonical units,
verify all paid results and final audio report, create the reviewed seed/config
receipts, then generate and independently review only the first20 items. Evaluate
the actual cost per approved item and the rejected reasons before building a bulk
Batch API scheduler or raising the pilot bounds. Editorial repair, uncertain-call
operator reconciliation, word/phrase application import and new audio are separate
work. This implementation does not claim that20,000 items are affordable or complete.

Offline validation:

```sh
node --test scripts/english-expansion/*.test.mjs
```

## Historical app allowance

Live activation now requires `expenseCoverage: "reviewed-ledgers-plus-bounded-historical-allowance"` and `historicalCommitments`. The old `expensesConfirmedComplete` boolean does not authorize spending. The historical receipt includes the exact `prior-app-cost-audit.json` as `audit`, its canonical `auditSha256`, the exact `historical-app-cost-coverage-20261024.json` as `coverage` with canonical `coverageSha256`, `HISTORICAL_COST_POLICY_SHA256` as `policySha256`, `schemaVersion: 1`, `kind: "bounded-historical-project-costs"`, `textUsd: 40`, `audioUsd: 11`, `releasePolicy: "never-automatic"`, and operator `reviewedBy` / `reviewedAt`. Root must review that receipt; these tools never create an activation approval.

The fixed USD 51 is a planning commitment, not a reported bill: USD 40 text covers the recorded USD 2.739465 estimate, three failed requests whose actual costs remain unknown at USD 8 each, plus contingency. USD 11 audio covers all 31,091 recorded requested characters at USD 0.33 / thousand plus contingency. No historical request is resubmitted and no reserve is automatically released. Current pipeline unknown outcomes still block spending. Any additional historical activity requires a new reviewed policy.

The allowance enters both USD 500 and JPY 100,000 guards by funding pool. Existing audio prepayments and consumed audio are not counted twice. The allowance's complete receipt is bound into the phase-one fingerprint, preventing later omission after the first phase-two reservation.
