import { requireSuperUser } from '@/server/auth';
import { BetaFeedbackInbox } from '@/components/beta-support';
export const dynamic = 'force-dynamic';
export default async function FeedbackInboxPage() { await requireSuperUser(); return <BetaFeedbackInbox/>; }
