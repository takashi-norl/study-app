import NextAuth from 'next-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { getAuthOptions } from '@/server/auth';
import { ApiError } from '@/server/config';
import { APPLE_BETA_INVITE_COOKIE, BETA_INVITE_COOKIE } from '@/server/beta-membership';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handler(request: NextRequest, context: { params: Promise<{ nextauth: string[] }> }) {
  try {
    // Resolve lazily so a deployment without credentials can still serve its public/demo screen.
    const params = await context.params;
    const provider = params.nextauth[1];
    const inviteCookie = provider === 'apple' ? APPLE_BETA_INVITE_COOKIE : BETA_INVITE_COOKIE;
    return await NextAuth(getAuthOptions({ provider, inviteToken: request.cookies.get(inviteCookie)?.value }))(request, { params });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: 'ログイン処理に失敗しました。', code: 'AUTH_FAILED' }, { status: 500 });
  }
}
export { handler as GET, handler as POST };
