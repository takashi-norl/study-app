import { APP_RELEASES, CURRENT_RELEASE, releaseDateLabel } from '@/lib/releases';
import styles from './release-notes.module.css';

export function ReleaseHistory() {
  return <ol className={styles.history}>{APP_RELEASES.map(release => <li key={release.version}>
    <div className={styles.meta}><strong>v{release.version}</strong><time dateTime={release.date}>{releaseDateLabel(release.date)}</time>{release.version === CURRENT_RELEASE.version && <span>最新</span>}</div>
    <h3>{release.title}</h3>
    <ul>{release.changes.map(change => <li key={change.title}><strong>{change.title}</strong><p>{change.description}</p></li>)}</ul>
  </li>)}</ol>;
}

export function ReleaseNotesCard() {
  return <section className={`panel ${styles.card}`} aria-labelledby="release-title">
    <div className={styles.heading}><div><h2 id="release-title">バージョンと更新履歴</h2><p>ひび学習 <strong>v{CURRENT_RELEASE.version}</strong> · {releaseDateLabel(CURRENT_RELEASE.date)}</p></div></div>
    <p className={styles.comment}>{CURRENT_RELEASE.announcement}</p>
    <details className={styles.details}><summary>更新履歴を見る</summary><ReleaseHistory /></details>
  </section>;
}
