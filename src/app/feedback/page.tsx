import { redirect } from 'next/navigation';
import { requireProfile } from '@/server/auth';
import { ApiError } from '@/server/config';
import { BetaFeedbackPanel } from '@/components/beta-support';
export const dynamic = 'force-dynamic';
export default async function FeedbackPage() {
  try { await requireProfile(); }
  catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/');
    throw error;
  }
  return <BetaFeedbackPanel/>;
}
