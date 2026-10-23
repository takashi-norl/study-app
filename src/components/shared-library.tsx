import Link from 'next/link';
import { ArrowRight, BookMarked, BookOpen } from 'lucide-react';
import styles from './shared-library.module.css';

/** Curated application material; personal uploads never enter this catalogue. */
export function LearningCatalog({ demo = false }: { demo?: boolean }) {
  return <section className={styles.library} aria-label="用意された教材">
    <div className="page-heading"><div><p className="eyebrow">LEARNING MATERIALS</p><h1>用意された教材</h1><p className="page-description">英語の読み・聞き・単語を、自分のペースで練習できます。</p></div></div>
    <p className={styles.intro}>アプリに用意された教材です。自分でアップロードした写真・PDFや作った問題が、ここに公開されることはありません。</p>
    {demo && <p className={styles.intro}>この教材はログイン後に使えます。デモの問題は「自分の問題・教材」から試せます。</p>}
    <div className={styles.grid}>
      <article className={`panel ${styles.card}`}><BookOpen size={26}/><h2>英検の読み・聞き・書き</h2><p>2級・準1級の問題を、本文・解説・音声と一緒に確認できます。</p><div className={styles.bottom}><Link className="button primary" href="/learn/eiken">教材を開く<ArrowRight size={16}/></Link></div></article>
      <article className={`panel ${styles.card}`}><BookMarked size={26}/><h2>英単語を学ぶ</h2><p>単語と例文を10語ずつ。音声を聞き、まとめてテストしたり、気になる言葉を調べたりできます。</p><div className={styles.bottom}><Link className="button primary" href="/learn/vocabulary">教材を開く<ArrowRight size={16}/></Link></div></article>
    </div>
  </section>;
}
