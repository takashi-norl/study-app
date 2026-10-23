# v5: one new phrase with explicit thinking disabled

This is a separate experiment, not a retry or an expansion of the existing v4
authority. All v1–v4 files, saved work, raw responses, prices and six settled
ledger entries remain immutable. In particular, the v4 result with no text and
16,000 thinking tokens remains a known billed truncation ($0.008479); none of its
three used phrases may be generated again here.

The root reviewer may approve exactly one **unused, already registered phrase**
for Haiku generation, followed only after inspecting the entire result by one
separately approved Sonnet review. No new seed registration, repair, automatic
review, publication, native approval or scale authorization is included.

| Stage | Exact policy | Counted / reserved input | Output ceiling | Worst reservation |
|---|---|---:|---:|---:|
| Generation | Haiku 5.5, `thinking:{type:'disabled'}`, medium | 50,000 / 100,000 | 16,000 | $0.018 |
| Optional review | Sonnet 5.5, high, unchanged review thinking policy | 25,000 / 50,000 | 8,000 | $0.180 |

The pair reserves at most **$0.198**, within the existing global USD 500 / JPY
100,000 guard. This is not a separate allowance. All previous phase-one and
phase-two costs, pending commitments, the fixed historical USD 51 allowance and
cash funding obligations remain included. Generation verifies headroom for the
optional review before paying. Six historical requests plus these two would be
eight, within the unchanged overall ten-call pilot cap.

The request explicitly disables thinking; a prompt instruction to omit reasoning
or `display:omitted` would not do that. `low` is not substituted for `medium`.
The 16,000 cap is the root's conservative choice rather than the research note's
8,000 suggestion; it adds at most $0.004 to that proposed generation reserve.
The approved authority records the reason and exact research hash without
changing the research. The same v4 quality instructions, original examples and
four-mode schema remain required. This parameter change does not guarantee
usable content.

## Before any request

Root creates a new exact authority matching `onePhraseBenchmarkAuthoritySchema`:
all six settled calls, raw evidence, disabled integration, registered store,
existing five approved cards, native scale hold, research, legacy and v5 code,
the single generation work/seed and the optional review policy are hash bound.
The prepared draft is deliberately `approved:false` and cannot execute. The old
integration remains `enabled:false`; neither old authority nor old optional
review is used for v5. No API call is made by preparing or checking these files.

The CLI defaults to a no-provider dry-run:

```sh
node scripts/english-expansion/one-phrase-benchmark-cli.mjs \
  --out /absolute/private/english-expansion-2026 \
  --base /absolute/private/vocabulary-assets-2026 \
  --runtime /private/tmp/hibi-vocabulary-build \
  --authority /absolute/private/reviewed-v5-authority.json \
  --work /absolute/private/v5-generation.work.json
```

Only adding `--send` after the exact authority is approved permits the single
paid submission. Credentials stay in `ANTHROPIC_API_KEY` in the root process.
All checks run under the existing shared spending lock; work, request and cost
reservation are durable before the zero-retry provider call. Raw is saved and
actual cost settled before parsing. No response means an unresolved reservation
and no resend. Known truncation is charged and retained once, not regenerated.

After a valid generation, root inspects every field. Known-bad content must not
be sent to a paid reviewer merely to exercise the gate. If warranted, build exact
`reviewWorkV5` and a separate `onePhraseReviewAuthoritySchema` receipt binding the
benchmark authority, complete generation raw envelope and exact review work.
Pass it as `--review-authority` with the review work. Without that receipt the
Sonnet call is blocked. Review saves private evidence only, with no change to
`approved/` or `native-recoveries/scale-hold.json`.

Native editorial recovery and Batch scale have not been extended to v5. Any
later use requires a separately reviewed workflow; success here does not silently
relax an existing hold or authorize additional requests.
