export const VOCABULARY_IMPORT_CONCURRENCY = 2;

type ImportQueueOptions<T> = {
  items: readonly T[];
  cacheKey: (item: T) => string;
  isCommitted: (item: T) => boolean;
  shouldStop: () => boolean;
  /** Must include response validation and receipt persistence, not just the upload. */
  perform: (item: T) => Promise<void>;
  /** Share across bundles in one user-started job. Never reuse for a manual restart. */
  attemptedKeys?: Set<string>;
};

/**
 * Two independent uploads, with at most one attempt per cache key in this job.
 * A failed/unknown upload is never retried here. Pause or failure stops admission;
 * already-started work always drains (including its receipt commit) before return.
 * This is a local queue guard, not a cross-tab or server-side storage lock.
 */
export async function runVocabularyImportQueue<T>(options: ImportQueueOptions<T>): Promise<void> {
  const attempted = options.attemptedKeys ?? new Set<string>();
  let nextIndex = 0;
  let failure: { cause: unknown } | undefined;

  async function worker() {
    try {
      while (!failure && !options.shouldStop() && nextIndex < options.items.length) {
        const item = options.items[nextIndex++];
        const key = options.cacheKey(item);
        if (options.isCommitted(item) || attempted.has(key)) continue;
        // No await between checking and reserving: sibling workers cannot claim it.
        attempted.add(key);
        await options.perform(item);
      }
    } catch (cause) {
      failure ??= { cause };
    }
  }

  // Workers absorb failures so Promise.all cannot return before the other drains.
  await Promise.all(Array.from({ length: VOCABULARY_IMPORT_CONCURRENCY }, () => worker()));
  if (failure) throw failure.cause;
}
