import type { MetadataRoute } from 'next';

/** Unknown/misconfigured deployments must not look like the learner's production app. */
export function isTestEnvironment(environment: string): boolean {
  return environment !== 'production' && environment !== 'local';
}

/** Presentation only: the server's environment configuration decides whether this is staging. */
export function appIdentity(staging: boolean) {
  return {
    staging,
    name: staging ? 'ひび学習 TEST' : 'ひび学習',
    title: staging ? 'ひび学習 TEST | 検証用アプリ' : 'ひび学習 | 少しずつ、できるに変わる。',
    description: staging ? 'ひび学習の検証用アプリ。日々の学習とは別の環境です。' : '自分の教材で、今日の10問。写真・PDFから作る問題と、自分のペースの復習。',
    themeColor: staging ? '#9a4518' : '#f7f8f3',
    icon: staging ? '/test-icon.svg' : '/icon.svg',
    appleIcon: staging ? '/test-apple-touch-icon.png' : '/apple-touch-icon.png',
  };
}

export function appManifest(staging: boolean): MetadataRoute.Manifest {
  const identity = appIdentity(staging);
  return {
    // Root-relative IDs resolve against each environment's own origin. Keep the installed production identity.
    id: '/', name: identity.name, short_name: identity.name,
    description: staging ? identity.description : '今日の10問と、忘れないための復習。',
    lang: 'ja', start_url: '/', scope: '/', display: 'standalone',
    background_color: '#f7f8f3', theme_color: identity.themeColor,
    icons: [
      { src: staging ? '/test-icon-192.png' : '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: staging ? '/test-icon-512.png' : '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: staging ? '/test-icon-512.png' : '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/** An installation link stays on the origin being viewed and never carries an invite token or route. */
export function appUrlForOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('アプリのURLを確認できません。');
  }
  return new URL('/', parsed.origin).href;
}
