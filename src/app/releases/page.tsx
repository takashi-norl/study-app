import type { Metadata } from 'next';
import Link from 'next/link';
import { ReleaseHistory } from '@/components/release-history';
import { CURRENT_RELEASE } from '@/lib/releases';
import styles from '../legal.module.css';

export const metadata: Metadata = { title: '更新履歴 | ひび学習', description: 'ひび学習のバージョンと、新しくできるようになったこと。' };
export const dynamic = 'force-dynamic';

export default function ReleasesPage() {
  return <main className={styles.page}><div className={styles.content}><Link href="/" className={styles.brand}>ひび学習</Link><article className={styles.card}>
    <h1>更新履歴</h1><p className={styles.updated}>最新バージョン v{CURRENT_RELEASE.version}</p><p>新しくできるようになったことを、ここにまとめています。</p><ReleaseHistory />
  </article><nav className={styles.footer} aria-label="関連ページ"><Link href="/">ひび学習を開く</Link><Link href="/install">iPhoneに追加する</Link></nav></div></main>;
}
