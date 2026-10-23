import type { VerbForms as VerbFormsData } from '@/lib/verb-forms';
import styles from './verb-forms.module.css';

function Form({ label, values }: { label: string; values: readonly string[] }) {
  return <div className={styles.form}><dt>{label}</dt><dd lang="en">{values.length ? values.join(' / ') : '—'}</dd></div>;
}

/** The most useful three forms stay visible; secondary forms expand without leaving the sentence. */
export default function VerbForms({ forms }: { forms?: VerbFormsData }) {
  if (!forms) return null;
  return <section className={styles.forms} aria-label="動詞の活用">
    <dl className={styles.mainForms}>
      <Form label="原形" values={forms.base} />
      <Form label="過去形" values={forms.past} />
      <Form label="過去分詞" values={forms.pastParticiple} />
    </dl>
    {forms.note && <p className={styles.note}>{forms.note}</p>}
    <details className={styles.additional}>
      <summary>ing形・三単現も見る</summary>
      <dl className={styles.extraForms}>
        <Form label="ing形" values={forms.presentParticiple} />
        <Form label="三単現" values={forms.thirdPersonSingular} />
      </dl>
    </details>
  </section>;
}
