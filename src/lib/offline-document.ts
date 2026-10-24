import { appIdentity } from './app-identity';

/** The service worker may cache this generic document. Never include account or study data. */
export function offlineDocument(testEnvironment: boolean): string {
  const identity = appIdentity(testEnvironment);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${identity.name} — 接続を確認</title><style>body{font:16px/1.8 system-ui,sans-serif;background:#f7f8f3;color:#183a31;padding:8vw;max-width:32rem;margin:10vh auto}h1{font-size:clamp(22px,6vw,28px)}a{color:inherit;display:inline-block;min-height:44px}aside{position:fixed;inset:0 0 auto;background:#9a4518;color:#fff8e9;font-size:12px;text-align:center;padding:calc(8px + env(safe-area-inset-top,0px)) 12px 8px}aside strong{margin-right:12px}</style></head><body>${testEnvironment ? '<aside aria-label="検証環境"><strong>ひび学習 TEST</strong>検証用の環境です</aside>' : ''}<h1>また、つながったら。</h1><p>現在インターネットに接続できません。学習記録を確実に保存するため、接続後にもう一度開いてください。</p><a href="/">もう一度開く →</a></body></html>`;
}
