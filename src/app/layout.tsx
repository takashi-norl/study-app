import type { Metadata, Viewport } from 'next';
import { appIdentity, isTestEnvironment } from '@/lib/app-identity';
import { getAppEnvironment } from '@/server/environment';
import styles from './environment-banner.module.css';
import './globals.css';

export function generateMetadata(): Metadata {
  const identity = appIdentity(isTestEnvironment(getAppEnvironment()));
  return {
    title: identity.staging ? { default: identity.title, template: '%s | TEST' } : identity.title,
    description: identity.description,
    manifest: '/manifest.webmanifest',
    appleWebApp: { capable: true, statusBarStyle: 'default', title: identity.name },
    icons: { icon: identity.icon, apple: identity.appleIcon },
    robots: { index: false, follow: false },
  };
}
export function generateViewport(): Viewport {
  return { width: 'device-width', initialScale: 1, viewportFit: 'cover',
    themeColor: appIdentity(isTestEnvironment(getAppEnvironment())).themeColor };
}
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>) {
  const environment = getAppEnvironment();
  const testEnvironment = isTestEnvironment(environment);
  return <html lang="ja"><body data-app-environment={environment} className={testEnvironment ? styles.stagingBody : undefined}>
    {testEnvironment && <aside className={styles.banner} aria-label="検証環境"><strong>ひび学習 TEST</strong><span>{environment === 'misconfigured' ? '環境設定を確認' : '検証用の環境です'}</span></aside>}
    {children}
  </body></html>;
}
