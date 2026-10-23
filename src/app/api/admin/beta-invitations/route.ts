import { requireSuperUser } from '@/server/auth';
import { betaAccessRevokedSchema, betaAdministrationState, createBetaInvitation, createBetaInvitationSchema, revokeBetaAccess } from '@/server/beta-membership';
import { loadOperationsEvents } from '@/server/google-store';
import { api, readJson } from '@/server/http';

export const runtime = 'nodejs';
export async function GET() { return api(async () => {
  await requireSuperUser();
  return betaAdministrationState(await loadOperationsEvents());
}); }
export async function POST(request: Request) { return api(async () => {
  const { profile } = await requireSuperUser();
  const result = await createBetaInvitation(profile, await readJson(request, createBetaInvitationSchema));
  return { ...result.invitation, path: `/join?token=${encodeURIComponent(result.token)}` };
}, 201); }
export async function DELETE(request: Request) { return api(async () => {
  const { profile } = await requireSuperUser();
  return revokeBetaAccess(profile, await readJson(request, betaAccessRevokedSchema));
}); }
