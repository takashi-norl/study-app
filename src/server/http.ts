import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiError } from './config';

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const expected = new URL(request.url).origin;
  if (origin && origin !== expected && origin !== process.env.NEXT_PUBLIC_APP_URL) {
    throw new ApiError(403, 'このページからの操作は許可されていません。', 'INVALID_ORIGIN');
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, '別のサイトからの操作は許可されていません。', 'INVALID_ORIGIN');
}

/** The browser origin may be forwarded to an upload provider only after validation. */
export function sameOriginForRequest(request: Request): string {
  assertSameOrigin(request);
  const origin = request.headers.get('origin') || new URL(request.url).origin;
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid origin');
  } catch {
    throw new ApiError(403, 'このページからの操作は許可されていません。', 'INVALID_ORIGIN');
  }
  return origin;
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  assertSameOrigin(request);
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 128 * 1024) throw new ApiError(413, '送信内容が大きすぎます。');
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw new ApiError(415, 'JSON形式で送信してください。');
  const text = await request.text();
  if (text.length > 128 * 1024) throw new ApiError(413, '送信内容が大きすぎます。');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ApiError(400, '送信内容を読み取れません。'); }
  return schema.parse(parsed);
}

export async function api(action: () => Promise<unknown>, status = 200) {
  try {
    return NextResponse.json(await action(), { status, headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: '入力内容を確認してください。', code: 'INVALID_INPUT', details: error.issues.map(i => ({ field: i.path.join('.'), message: i.message })) }, { status: 400 });
    if (error instanceof ApiError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    // Avoid exposing SQL, tokens, source text, or provider request bodies to clients/logs.
    console.error('Study API failure:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: '処理に失敗しました。少し待ってからもう一度お試しください。', code: 'SERVER_ERROR' }, { status: 500 });
  }
}

export function checkDb(error: { message: string; code?: string } | null) {
  if (error) throw new ApiError(500, 'データを保存・取得できませんでした。データベースの設定をご確認ください。', 'DATABASE_ERROR');
}
