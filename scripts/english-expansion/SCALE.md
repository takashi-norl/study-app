# Reviewed Batch expansion (text only)

This is a separate, disabled-by-default worker. It does not alter the initial
pilot's 20-item / 10-request limits, purchase credits, generate audio, or publish
to the application. The 20,000-library target is a budget-bounded goal, not a
claim that the remaining money will cover 12,500 additional approved cards.

## Activation evidence

Keep the existing `shared-spending-integration.json` and completed, frozen base.
Before a live wave, root must independently accept the **observed** pilot quality
and cost and install `runtime/shared-spending-scale.json`. No helper creates it.
The receipt fields are:

```js
{
  schemaVersion: 1, enabled: true,
  scope: 'reviewed-text-batch-expansion',
  reviewedBy: '/root', reviewedAt: '<ISO timestamp>', approved: true, issues: [],
  integrationSha256: '<hashContent(existing exact integration receipt)>',
  policySha256: SCALE_POLICY_SHA256,
  batchPolicySha256: BATCH_POLICY_SHA256,
  pilotSnapshotSha256: '<hashContent(await measuredPilotSnapshot(output, seeds, config.pilotRepair))>',
  measuredPilotUsd: '<snapshot.actualUsd number>',
  pilotApprovedUnits: '<snapshot.approvedUnits number>',
  maxAdditionalUnits: 12480,
  budgetBoundedTarget: true, textOnly: true,
  files: [{id: '<each scaleFiles().id>', sha256: '<sha256File(path)>'}]
}
```

All 20 pilot items must have one final generation lineage and one exact independent
review, settled response-backed costs, and at least 18 approvals. An explicitly authorized
pilot repair retains both original and repair costs, counts its final IDs once,
and requires immutable repair evidence. Held items are
included with content/review hashes and issues, remain unpublished, and do not
count as completed cards. Root can withhold scale approval even above 18 when a
systemic quality issue remains. The forecast divides actual pilot spend by
**approved** items, applies the Batch discount and 50% contingency; it is not an
invoice or a guarantee. A cap of 12,480 new candidates deliberately does not
automatically replace held pilot or scale cards.

The original live gate still verifies 7,500 canonical base lexical families,
complete audio/text outcomes, stopped phase one, actual shared spending fence,
all historical costs (the fixed $51 allowance), and confirmed prepaid cash.
Scale costs share the **same `ledger.json`** as the pilot. Cash prepayment and
consumed audio credit are not counted twice. Neither USD 500 nor the conservative
JPY 100,000 guard is raised.

## Reviewed candidate inbox

Put a matching pair in the private expansion directory:

`scale/inbox/<id>.source.json` and `scale/inbox/<id>.review.json`.

Source: `{schemaVersion:1,id,createdBy,seeds:[...validateSeed-compatible...]}`,
1–1,000 entries. Review:
`{schemaVersion:1,sourceSha256,reviewedBy,reviewedAt,verdicts:[{id,approved:true,issues:[]}]}`.
Reviewer identity must differ from the author. The entire source is hash-bound;
every seed needs a verdict. An independently operating AI reviewer is allowed.
No per-file human confirmation is built into this stage.

The importer rejects overlap against base cards, retained non-base cards,
quarantined inventory, canonical forms/explicit aliases/verb forms, pilot seeds,
and earlier scale sources. Same source replays are idempotent; changed source
under an existing ID fails. Source/review evidence is saved before the index.
Interrupted unindexed writes fail closed for explicit reconciliation.

**Candidate generation itself is not implemented here.** The initial reviewed
200 candidates can be processed, then the worker exits with
`reviewed-inventory-needed`. It will not silently invent more candidates,
reprocess failed ones, or wait forever. A later economical candidate generator
must use this same shared budget and independent review/dedup policy.

## Bounded run

Only after root installs the two activation receipts:

```sh
node scripts/english-expansion/scale-worker.mjs \
  --out /absolute/private/english-expansion-2026 \
  --phase-one /absolute/private/vocabulary-assets-2026 \
  --runtime /private/tmp/hibi-vocabulary-build \
  --cycles 1440 --run-reviewed-scale
```

`ANTHROPIC_API_KEY` is read only from the private process environment. No API was
called while implementing/testing this worker. Tests use an explicitly
network-disabled SDK and synthetic local fixtures.

One wave contains at most 40 requests, with at most five items each. There is
only one outstanding provider batch. Reviews of saved drafts precede any new
generation. The worker selects only an affordable prefix and leaves the full
review ceilings available before submitting generation. A quality hold above
10% stops further generation after reviewing available drafts. No held card is
automatically repaired or regenerated.

The loop waits 60 seconds between observations and runs at most 1,440 cycles.
It stops cleanly for inventory exhaustion, quality hold, budget exhaustion, or
`runtime/stop-scale`. A single cycle can still collect an already known batch
after the stop marker because collection makes no paid submission. Root may
resume collection after stopping the loop. Batch completion can take up to 24
hours; no artificial progress percentage or guaranteed overnight finish is used.

## Durable payment/result boundary

1. Save exact work, quote and request, then immutable wave plan.
2. Save every request's full reservation in the shared ledger.
3. Recheck both receipts, the real phase-one gate and stop marker.
4. Save the submitting marker and `requested` ledger status **before** network.
5. Make one Batch create call with SDK retries disabled.
6. Save the complete create response before extracting its ID.
7. Poll only that known provider ID. Download each raw result before pricing,
   parsing or publication. Require the complete exact ID set and a complete
   result-stream index; duplicates, omissions and changed results fail closed.
8. Settle actual discounted costs. Parse exact schema, save drafts, request a
   separate independent review, and only then write private approved assets.

A missing create response, unknown network outcome, unsent interrupted
reservation, or unexpected billing blocks new spending. A new ID is **not**
retry permission. Read-only result downloads can be repeated and identical raw
rows reused after interruption. Old raw data, reservations and rejected content
are never overwritten. Actual charge above reservation stays as an accounting
hold. Exact terminal `errored`, `canceled` and `expired` rows from a proven ended
batch settle to zero under the official no-charge rule, retaining the original
reservation/audit trail and holding those cards without automatic retries.

The current verified model is Sonnet 5.5, with the v2 prompt/schema and medium effort,
region and service-tier settings as the pilot. Standard $2/$10 per million
input/output tokens and $0.10 cached input are discounted 50% for Batch. Hidden
thinking is already part of output usage and is not charged again locally.
Pricing verification expires after seven days; a later run requires a fresh
review. See [official Batch documentation](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
and [official pricing](https://platform.claude.com/docs/en/about-claude/pricing).

Validation: `node --test scripts/english-expansion/scale.test.mjs`.
