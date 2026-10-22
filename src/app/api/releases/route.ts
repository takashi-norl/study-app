import { CURRENT_RELEASE } from '@/lib/releases';

export const dynamic = 'force-dynamic';

export function GET() {
  const { version, date, title, announcement } = CURRENT_RELEASE;
  return Response.json({ version, date, title, announcement }, { headers: { 'Cache-Control': 'no-store, max-age=0', 'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store' } });
}
