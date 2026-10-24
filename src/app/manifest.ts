import { appManifest, isTestEnvironment } from '@/lib/app-identity';
import { getAppEnvironment } from '@/server/environment';

// Read the deployed environment, while retaining the existing /manifest.webmanifest URL.
export const dynamic = 'force-dynamic';

export default function manifest() {
  return appManifest(isTestEnvironment(getAppEnvironment()));
}
