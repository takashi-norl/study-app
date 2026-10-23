# Haiku comparison: three existing pilot items, at most two new requests

This is a separate, synchronous benchmark. It does not activate the old pilot or Batch worker. Keep `shared-spending-integration.json` exactly `enabled:false` and retain `native-recoveries/scale-hold.json`. No application model, UI, schema, public catalog or historical work version changes.

The root reviewer first checks the frozen v4 generation work, all module hashes, pricing research and the complete existing store/ledger/approved snapshot, then writes a **new** authority matching `cheapBenchmarkAuthoritySchema`. A draft with `approved:false` is intentionally not executable. This authority allows only one Haiku generation and an optional separately authorized Sonnet review. It cannot register seeds, retry a used seed, replace approved assets, publish or enable scale.

| Stage | Model / effort | Accepted counted input | Reserved full input | Maximum output, including thinking | Worst reservation |
|---|---|---:|---:|---:|---:|
| Generate 1–3 registered unused items | Haiku 5.5 / medium | 50,000 | 100,000 | 16,000 | $0.018 |
| Review those exact cards | Sonnet 5.5 / high | 25,000 | 50,000 | 8,000 | $0.180 |

The pair is at most **$0.198 reserved**, not an actual-cost quote. The standard synchronous prices are Haiku $0.10/$0.50 and Sonnet $2/$10 per million input/output tokens. No Batch discount, cache writes, tools, region premium or priority tier is assumed. Haiku requests above the 100,000-input tier are prohibited. Unexpected actual usage retains an accounting hold; reasoning already belongs to output tokens and is not charged twice.

Generation checks optional review headroom against the shared USD 500 / JPY 100,000 guard, including all phase-one text/audio reservations, historical USD 51 allowance and cash funding obligations. Existing five calls are immutable baseline evidence. New reservations are appended to the same ledger, under the same exclusive shared spending lock. The overall initial pilot remains at most 20 registered items / 10 total paid requests. The root authority narrows this benchmark to 3 items / 2 added requests.

## Read-only planning and explicit execution

Default is a no-provider dry-run. Root installs the actual reviewed authority only after inspection:

```sh
node scripts/english-expansion/cheap-benchmark-cli.mjs \
  --out /absolute/private/english-expansion-2026 \
  --base /absolute/private/vocabulary-assets-2026 \
  --runtime /private/tmp/hibi-vocabulary-build \
  --authority /absolute/private/reviews/cheap-benchmark-authority.json \
  --work /absolute/private/generation.work.json
```

Adding `--send` explicitly permits the one authorized paid submission. Credentials are read from `ANTHROPIC_API_KEY` in memory; never from an authority or work file. The SDK has zero automatic retries. State is reserved and marked requested before the provider call; complete raw is saved before parsing. A missing raw for an existing request **never** triggers resubmission. Exact saved raw replay uses no provider/model/token calls.

After generation, inspect every definition, example, choice, feedback and alternative. Do not pay to review known-bad content. If appropriate, create `reviewWorkV4` from the unchanged saved complete cards, then obtain a separate root receipt matching `cheapReviewAuthoritySchema`:

- exact original benchmark authority hash;
- exact saved generation raw envelope hash;
- exact Sonnet review work hash;
- root reviewer, timestamp, approved true.

Pass its path through `--review-authority` and the review work through `--work`. Missing/stale approval closes the gate. The review saves full verdicts under the request directory but does **not** add anything to `approved/`. Root must assess concrete quality and measured costs separately. The current scale hold remains unchanged, regardless of the model's verdicts.

## Scope and recovery limits

Old v1/v2/v3 prompts, pricing, ledger and raw replay remain on their existing implementation. This runner accepts only exact v4 constructors and exact IDs in its new authority; there is no fallback to another scope/model. Native editorial recovery currently supports older generation versions only; this benchmark does not implicitly extend that workflow. Known malformed/truncated output is retained and charged once, not silently regenerated. Unknown transport or billing outcomes stop all further spending pending explicit reconciliation.
