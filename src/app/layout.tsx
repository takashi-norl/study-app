import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ひび学習 | 少しずつ、できるに変わる。',
  description: '家族で育てる問題集。今日の10問と、忘れないための復習。',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'ひび学習' },
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#f7f8f3',
};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>) {
  return <html lang="ja"><body>{children}</body></html>;
}
