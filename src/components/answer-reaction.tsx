'use client';

import { Check, Sparkles, RotateCcw } from 'lucide-react';
import { answerReaction } from '@/lib/answer-reaction';
import styles from './answer-reaction.module.css';

export function AnswerReaction({ correct, streak, comeback, animated }: { correct: boolean; streak: number; comeback: boolean; animated: boolean }) {
  const reaction = answerReaction(correct, streak, comeback);
  return <div className={`${styles.reaction} ${correct ? styles.correct : styles.wrong} ${animated ? styles.animated : ''}`}>
    <div className={styles.emblem} aria-hidden="true">
      {correct ? <Check size={28} strokeWidth={3}/> : <RotateCcw size={25}/>}
      {correct && animated && <span className={styles.sparkles}>{Array.from({ length: 6 }, (_, i) => <i key={i}/>)}</span>}
    </div>
    <div className={styles.words}>
      <div className={styles.heading}><h2>{reaction.message}</h2>{correct && streak >= 3 && <span className={styles.streak}><Sparkles size={13} aria-hidden="true"/>{streak}問連続</span>}</div>
      <p>{correct ? comeback ? 'さっきの1問から、また前へ。' : 'この調子で、一問ずつ。' : '正解と見比べよう。次の復習で、もう一度。'}</p>
    </div>
  </div>;
}

export function AnswerEffectsSwitch({ enabled, onChange, disabled, compact = false }: { enabled: boolean; onChange: (enabled: boolean) => void; disabled?: boolean; compact?: boolean }) {
  return <label className={`${styles.option} ${compact ? styles.compact : ''}`}>
    <span><strong>{compact ? '動き・振動' : '回答のリアクション'}</strong>{!compact && <small>小さなお祝いと、対応する端末での振動。音は鳴りません。</small>}</span>
    <input type="checkbox" role="switch" aria-label="回答の動き・振動" checked={enabled} disabled={disabled} onChange={event => onChange(event.target.checked)}/>
    <span className={styles.switch} aria-hidden="true"/>
  </label>;
}
