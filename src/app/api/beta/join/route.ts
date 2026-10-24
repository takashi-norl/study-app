import { acceptBetaInvitationSchema, APPLE_BETA_INVITE_COOKIE, BETA_INVITE_COOKIE, checkBetaInvitation } from '@/server/beta-membership';
import { api, readJson } from '@/server/http';
import { getAppleAuthConfig } from '@/server/apple-auth-config';
import { ApiError } from '@/server/config';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  let acceptedToken: string | undefined;
  let apple = false;
  const response = await api(async () => {
    const input = await readJson(request, acceptBetaInvitationSchema);
    apple = input.provider === 'apple';
    if (apple && !getAppleAuthConfig()) throw new ApiError(503, 'Appleログインは現在準備中です。', 'APPLE_UNAVAILABLE');
    await checkBetaInvitation(input.token);
    acceptedToken = input.token;
    return { accepted: true };
  });
  if (acceptedToken) {
    response.cookies.set(apple ? APPLE_BETA_INVITE_COOKIE : BETA_INVITE_COOKIE, acceptedToken, {
      httpOnly: true, sameSite: apple ? 'none' : 'lax', secure: apple || process.env.NODE_ENV === 'production' || new URL(request.url).protocol === 'https:', path: '/', maxAge: 15*60,
    });
  }
  return response;
}
