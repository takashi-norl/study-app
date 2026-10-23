export interface SourceReading {
  sourceId: string;
  revision: string | null;
  analysis: { text: string; learningPoints: string[]; uncertainties: string[] } | null;
  updatedAt?: string;
  reviewed: boolean;
}

/** Fail closed if a proxy or stale response returns something other than the requested source. */
export async function parseSourceReadingResponse(response: Response, sourceId: string): Promise<SourceReading> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    const message = typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '読み取り内容を取得・保存できませんでした。';
    throw new Error(message);
  }
  if (!body || typeof body !== 'object') throw new Error('読み取りの保存状態を確認できませんでした。もう一度お試しください。');
  const value = body as Partial<SourceReading>;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string');
  if (value.sourceId !== sourceId || !(value.revision === null || typeof value.revision === 'string')
    || typeof value.reviewed !== 'boolean' || (value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))))
    || !(value.analysis === null || value.analysis && typeof value.analysis.text === 'string' && strings(value.analysis.learningPoints) && strings(value.analysis.uncertainties))) {
    throw new Error('この教材の読み取りを確認できませんでした。もう一度お試しください。');
  }
  return value as SourceReading;
}

type LoadResult = { status: 'loaded'; reading: SourceReading } | { status: 'failed'; message: string } | { status: 'superseded' };

/** Cancellation also invalidates late responses from fetch implementations that ignore AbortSignal. */
export function createSourceReadingLoader(fetcher: typeof fetch = fetch, timeoutMs = 30000) {
  let sequence = 0;
  let controller: AbortController | undefined;
  const cancel = () => { sequence += 1; controller?.abort(); controller = undefined; };
  return {
    cancel,
    async load(sourceId: string): Promise<LoadResult> {
      cancel();
      const current = sequence;
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), timeoutMs);
      try {
        const response = await fetcher(`/api/sources/${encodeURIComponent(sourceId)}/analysis`, { cache: 'no-store', signal: request.signal });
        const reading = await parseSourceReadingResponse(response, sourceId);
        return current === sequence ? { status: 'loaded', reading } : { status: 'superseded' };
      } catch (reason) {
        if (current !== sequence) return { status: 'superseded' };
        return { status: 'failed', message: request.signal.aborted ? '読み取りの取得が完了しませんでした。接続を確認して、もう一度お試しください。' : reason instanceof Error ? reason.message : '読み取り内容を取得できませんでした。' };
      } finally {
        clearTimeout(timeout);
        if (current === sequence) controller = undefined;
      }
    },
  };
}
