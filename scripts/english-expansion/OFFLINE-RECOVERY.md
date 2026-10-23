# Private native review recovery

This offline tool preserves every paid response, cost, held verdict and existing
draft. It never calls a provider, updates activation, creates audio, exports to the
app, or authorizes scaling. The original twenty-item pilot limit remains intact.

The first version handles ordinary v1/v2/v3 generation drafts only. A source with
any later paid review/repair or another draft revision is rejected. In particular,
the earlier five cards with repair and editorial-overlay history must use a future
separate recovery extension; pointing this tool at their first generation would
discard their latest evidence and is forbidden.

Prepare under the private output's `reviews/` directory:

1. A `nativeRecoveryProposalSchema` document with exact generation work/raw/draft
   hashes, original independent held receipt, all test changes and complete final
   units. `material-correction` requires actual changes; `review-adjudication`
   requires an identical card and an explicit reason for overruling the finding.
2. A `nativeRecoveryReviewSchema` receipt from an independent native AI reviewer
   who read all final cards. The reviewer cannot be the editor or original author.
3. A `nativeRecoveryRootSchema` approval binding the exact proposal and review.

All four question modes and three examples remain. The seed, meanings, examples,
IDs and original author provenance are unchanged. Only existing test text/index
leaves, or an exact context-alternatives array, may change. This is structural
verification, not an automated substitute for semantic review.

The production stop file must exist, production/shared work locks must be absent,
and the integration configuration must be explicitly disabled for these private
directories. Every paid call must be complete, priced within its retained
reservation and backed by its saved response. Unknown outcomes fail closed.

```sh
node scripts/english-expansion/offline-native-recovery-cli.mjs \
  --out /absolute/private/english-expansion-2026 \
  --runtime /private/tmp/hibi-vocabulary-build \
  --proposal /absolute/private/english-expansion-2026/reviews/proposal.json \
  --review /absolute/private/english-expansion-2026/reviews/review.json \
  --root /absolute/private/english-expansion-2026/reviews/root-approval.json
```

Default is dry-run. Add `--write` only after root review. The tool acquires the same
exclusive spending fence, saves immutable authority/source evidence/intent first,
then drafts, final review receipts and private `approved/<unitId>.json` records.
Each approved record retains the original verdict and source cost as provenance;
the spending ledger itself is never rewritten or duplicated. Different existing
approvals cannot be replaced. An interrupted exact intent can finish without a
paid retry; a changed intent or missing completed approval requires inspection.

`native-recoveries/scale-hold.json` is written before approval. The measured scale
gate explicitly refuses it. There is no automatic removal or bypass; any later
scale-policy change requires separate quality and cost review. These private
approvals do not imply twenty pilot cards or twenty thousand library items exist.
