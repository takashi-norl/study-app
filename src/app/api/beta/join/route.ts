import { acceptBetaInvitationSchema, BETA_INVITE_COOKIE, checkBetaInvitation } from '@/server/beta-membership';
import { api, readJson } from '@/server/http';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  let acceptedToken: string | undefined;
  const response = await api(async () => {
    const input = await readJson(request, acceptBetaInvitationSchema);
    await checkBetaInvitation(input.token);
    acceptedToken = input.token;
    return { accepted: true };
  });
  if (acceptedToken) {
    response.cookies.set(BETA_INVITE_COOKIE, acceptedToken, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' || new URL(request.url).protocol === 'https:', path: '/', maxAge: 15*60,
    });
  }
  return response;
}
