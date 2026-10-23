import type { Metadata } from 'next';
import BetaJoin from '@/components/beta-join';
export const metadata: Metadata = { title: 'ひび学習への招待', referrer: 'no-referrer', robots: { index: false, follow: false } };
export default async function JoinPage({ searchParams }: { searchParams: Promise<{ token?: string | string[]; error?: string | string[] }> }) {
  const params = await searchParams;
  return <BetaJoin token={typeof params.token === 'string' ? params.token : undefined} loginError={!!params.error} />;
}
