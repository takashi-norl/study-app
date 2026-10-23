# Durable phase-two foundation — mock only

`store.mjs` and `dispatcher.mjs` are an offline foundation, not a production worker.
There is no SDK, HTTP implementation, API key loader, CLI, or audio generation in
these modules. `assertProductionDispatchReady()` always throws
`LIVE_EXPANSION_NOT_INTEGRATED`. Calling code must not remove that blocker merely
because the budget has room or the phase-one process happens to be idle.

## State and evidence

A caller chooses a private output directory and one shared lock directory. An
exclusive `mkdir` acquires that lock; its owner nonce is verified before writes.
An existing lock is never stolen or cleared automatically. Every JSON write uses
a private temporary file, file fsync, an atomic rename or no-overwrite hard link,
and directory fsync. Store methods require an actual branded lease.

The output contains:

- `store.json`: frozen phase-one fingerprint, allocation hash, lock identity,
  and at most 20 distinct pilot seeds.
- `ledger.json`: immutable reservations and monotonic request states. Missing
  spending history in an initialized store is fatal.
- `requests/<id>/request.json`: exact provider parameters and their hash.
- `requests/<id>/response.json`: raw response saved before pricing or decoding.
- `drafts/<unit-id>/<hash>.json`: validated content bound to the registered seed.
- `reviews/<unit-id>/<hash>.json`: independent, current-content approval receipt.
- `approved/<unit-id>.json`: immutable approved private asset. This directory
  does not publish anything to the application or make it visible to users.

`dispatchWithMockProvider` accepts only an explicitly mocked provider. Its fixture
provider exposes `request(params)`, synchronous `price(raw)` and synchronous
`decode(raw)`. It saves the request and full worst-case reservation, then the
`requested` marker, before entering the provider boundary. It saves the complete
raw response before pricing or decoding. The shared dollar, yen and funding-pool
guards from `budget.mjs` remain in force. At most five units can be included in a
request; the first pilot permits at most ten generation/review requests in total.

A thrown provider call becomes `uncertain`, retains its entire reservation and
blocks new spending. Replaying the same identity never resends it. A saved but
unsent reservation also needs explicit operator reconciliation; this foundation
does not automatically resume it. If raw data is saved but pricing or validation
fails, a later invocation can reuse that saved response without another request.
Known completed cost, including zero, is preserved. A charge above its ceiling
creates an accounting hold. Raw-response or completed-cost evidence cannot be
silently replaced. Failed content needs a deliberate new revision, not a hidden
retry loop.

## Real phase-one checks, even in the mock harness

The gate reads actual files and derives lifecycle flags itself. It requires:

1. A stop checkpoint and absence of production, text-build and audio work locks.
2. All text outcomes settled and all audio reservations either ready or an
   explicitly known quota rejection; missing or uncertain evidence blocks.
3. Exactly 7,500 distinct, hash-approved/frozen base entries matching the 7,500
   nonheld manifest entries, each approved or preserved. Quarantined inventory
   may remain outside that total, but is never counted as completed. Its words
   and aliases stay in the dedup registry and need a deliberate review workflow
   before reuse.
4. A complete final audio report for all newly approved base entries.
5. The same frozen catalog/accounting fingerprint when reopening the store,
   before reserving, and immediately before the mocked provider boundary.

Tests use a two-entry fixture through `mockExpectedBaseTarget`. That option is
not authority to launch a partial live catalog. The production entry point is
disabled regardless of its value. Caller-supplied lifecycle booleans do not
override filesystem evidence.

## Remaining work before a paid first pilot

The existing phase-one worker **does not yet acquire this shared lock**. Merely
holding it here cannot prevent that old worker restarting. Its entire launch and
paid-dispatch path must honor the same exclusive spending fence, and phase one
must be stopped and drained, before a real phase-two adapter is enabled. This is
the outstanding TOCTOU blocker, not an implemented production guarantee.

The next integration also needs reviewed provider-specific token counting and
worst-case pricing, generation/review prompt and parsing adapters, a durable
queue or batch submit/collect reconciler, explicit operator handling for unknown
submissions, a review-identity/content-binding adapter, and an importer for word
and phrase assets. The first actual 20-item pilot must be reviewed for quality
and marginal cost before authorizing a larger wave. New audio is deferred and
would need a separate reservation under the same overall budget.

Low-level store writes are not spending authorization. Future production code
must use the full gate/reservation flow and must never turn a mocked provider
into a disguised network client. No claim is made that 20,000 items are created,
reviewed, affordable, or published by this foundation.

Run the isolated mocked checks with:

```sh
node --test scripts/english-expansion/*.test.mjs
```
