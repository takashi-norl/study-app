import { isTestEnvironment } from '@/lib/app-identity';
import { offlineDocument } from '@/lib/offline-document';
import { getAppEnvironment } from '@/server/environment';

export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(offlineDocument(isTestEnvironment(getAppEnvironment())), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
