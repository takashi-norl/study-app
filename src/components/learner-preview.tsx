'use client';

import { PracticeStart } from './practice-start';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Eye, Globe2, Home, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react';
import { demoPracticeQuestions, demoStudyDataForProfile } from '@/lib/demo-access';
import { selectQuestions } from '@/lib/learning';
import type { LearnerPreviewPayload } from '@/lib/learner-preview';
import { useLearnerPreview } from '@/lib/use-learner-preview';
import type { StudyController } from './controller';
import { LearningProjects } from './learning-projects';
import { QuestionLibrary } from './question-library';
import styles from './learner-preview.module.css';

type LoadedPreview = { key: string; payload: LearnerPreviewPayload | null; error: string | null; loading: boolean };

export function LearnerPreview({ c, onExit, renderPractice, initialLearnerId }: {
  c: StudyController;
  initialLearnerId?: string;
  onExit: () => void;
  renderPractice: (controller: StudyController) => ReactNode;
}) {
  const learners = c.data.profiles.filter(profile => profile.role === 'student' && profile.familyId === c.profile.familyId);
  const [requestedId, setRequestedId] = useState(initialLearnerId ?? learners[0]?.id ?? '');
  const learnerId = learners.some(profile => profile.id === requestedId) ? requestedId : learners[0]?.id ?? '';
  const learner = learners.find(profile => profile.id === learnerId);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
  const latest = useRef(c);
  latest.current = c;
  const key = `${c.profile.id}:${c.profile.familyId}:${c.demo}:${learnerId}:${revision}`;
  const current = loaded?.key === key ? loaded : null;
  const loading = !!learnerId && (!current || current.loading);

  useEffect(() => {
    if (!learnerId || latest.current.profile.role !== 'parent') return;
    const controller = new AbortController();
    let cancelled = false;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    setLoaded({ key, payload: null, error: null, loading: true });
    async function load() {
      try {
        const source = latest.current;
        const target = source.data.profiles.find(profile => profile.id === learnerId
          && profile.role === 'student' && profile.familyId === source.profile.familyId);
        if (!target) throw new Error('表示する学習者を選び直してください。');
        let payload: LearnerPreviewPayload;
        if (source.demo) {
          const data = demoStudyDataForProfile(source.data, target);
          const ids = new Set(data.questions.map(question => question.id));
          payload = { data, profile: target, practiceQuestions: demoPracticeQuestions(source.data, target).filter(question => ids.has(question.id)) };
        } else {
          const response = await fetch(`/api/admin/learner-preview?learnerId=${encodeURIComponent(target.id)}`, {
            signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
          });
          const result = await response.json();
          if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'ユーザーの表示を取得できませんでした。');
          payload = result as LearnerPreviewPayload;
        }
        if (payload.profile.id !== target.id || payload.profile.role !== 'student'
          || payload.profile.familyId !== source.profile.familyId) throw new Error('表示する学習者を確認できませんでした。もう一度取得してください。');
        if (!cancelled) setLoaded({ key, payload, error: null, loading: false });
      } catch (error) {
        if (!cancelled) setLoaded({ key, payload: null, loading: false,
          error: timedOut ? '取得に時間がかかっています。接続を確認して、もう一度取得してください。'
            : error instanceof Error ? error.message : 'ユーザーの表示を取得できませんでした。' });
      } finally { clearTimeout(timeout); }
    }
    void load();
    return () => { cancelled = true; clearTimeout(timeout); controller.abort(); };
  }, [key, learnerId, c.demo, c.profile.familyId]);

  const refresh = () => setRevision(value => value + 1);
  if (c.profile.role !== 'parent') return null;
  return <section className={styles.preview} aria-label="ユーザー表示プレビュー">
    <div className={styles.banner}>
      <div className={styles.bannerHeading}><Eye size={21}/><div><strong>ユーザー表示プレビュー</strong><p>{learner ? `${learner.name}さんとして表示` : '表示する学習者が未登録です'} · 回答・出題履歴・設定は保存されません</p></div></div>
      <div className={styles.controls}>
        <label><span>表示するユーザー</span><select value={learnerId} disabled={!learners.length} onChange={event => setRequestedId(event.target.value)}>{!learners.length && <option value="">学習者がいません</option>}{learners.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <button type="button" className={styles.refresh} disabled={loading || !learnerId} onClick={refresh}><RefreshCw size={16}/><span>最新の表示を取得</span></button>
        <button type="button" className={styles.exit} onClick={onExit}><ArrowLeft size={16}/>管理画面に戻る</button>
      </div>
    </div>
    {!learners.length ? <div className={styles.empty}><BookOpen size={28}/><h2>プレビューできる学習者がいません</h2><p>同じ家族の学習者アカウントが登録されると、そのユーザーに見える問題を確認できます。</p></div>
      : loading ? <div className={styles.empty} role="status"><LoaderCircle className="spin" size={28}/><h2>ユーザーの表示を確認しています</h2><p>見える問題集と、今出題できる問題を取得しています。</p></div>
      : current?.error ? <div className={styles.empty} role="alert"><h2>プレビューを取得できませんでした</h2><p>{current.error}</p><button type="button" className="button primary" onClick={refresh}><RefreshCw size={16}/>もう一度取得する</button></div>
      : current?.payload ? <PreviewContents key={key} payload={current.payload} demo={c.demo} refresh={refresh} renderPractice={renderPractice}/> : null}
  </section>;
}

function PreviewContents({ payload, demo, refresh, renderPractice }: {
  payload: LearnerPreviewPayload; demo: boolean; refresh: () => void;
  renderPractice: (controller: StudyController) => ReactNode;
}) {
  const c = useLearnerPreview(payload, demo, refresh);
  const [view, setView] = useState<'home' | 'private' | 'public' | 'projects'>('home');
  const privateTopics = c.data.topics.filter(topic => !topic.libraryPublished);
  const publicTopics = c.data.topics.filter(topic => topic.libraryPublished && !topic.testOnly);
  const added = new Set(c.data.plans.filter(plan => plan.ownerId === c.profile.id && !plan.testOnly && plan.libraryTopicId).map(plan => plan.libraryTopicId));
  const privateIds = new Set(privateTopics.map(topic => topic.id));
  const privateQuestions = c.data.questions.filter(question => privateIds.has(question.topicId)).length;
  const publicQuestions = c.data.questions.filter(question => added.has(question.topicId)).length;
  const adoptedCount = publicTopics.filter(topic => added.has(topic.id)).length;
  const available = selectQuestions(c.data.questions, c.data.attempts, c.data.exposures, c.profile.id, 'daily');
  const weak = selectQuestions(c.data.questions, c.data.attempts, c.data.exposures, c.profile.id, 'weak');
  const open = (next: typeof view) => { c.actions.finishSession(); setView(next); };
  return <div className={styles.contents}>
    <nav className={styles.navigation} aria-label="プレビュー内の移動">
      <button type="button" aria-current={!c.session && view === 'home' ? 'page' : undefined} onClick={() => open('home')}><Home size={16}/>学習ホーム</button>
      <button type="button" aria-current={!c.session && (view === 'private' || view === 'public') ? 'page' : undefined} onClick={() => open('private')}><BookOpen size={16}/>問題集を見る</button>
      <button type="button" aria-current={!c.session && view === 'projects' ? 'page' : undefined} onClick={() => open('projects')}>学習プラン・進み具合</button>
      <span>作成・編集・追加などの変更操作は無効です</span>
    </nav>
    {c.error && <p className={styles.error} role="alert">{c.error}</p>}
    {c.practiceStart ? <PracticeStart c={c}/> : c.session ? renderPractice(c) : view === 'projects' ? <LearningProjects c={c}/> : view !== 'home'
      ? <QuestionLibrary c={c} initialTab={view} onCreate={() => {}} onEdit={() => {}}/>
      : <>
        <div className={styles.heading}><p>LEARNER VIEW</p><h1>{c.profile.name}さんの学習画面</h1><span>本人の問題集と、本人が追加した公開問題集が出題の対象です。</span></div>
        <div className={styles.visibility}>
          <button type="button" onClick={() => setView('private')}><LockKeyhole size={21}/><span><strong>自分の問題集</strong><b>{privateTopics.length}<small>冊 · {privateQuestions}問</small></b><em>ほかのユーザーの原本は表示されません</em></span><ArrowRight size={17}/></button>
          <button type="button" onClick={() => setView('public')}><Globe2 size={21}/><span><strong>公開から追加済み</strong><b>{adoptedCount}<small>冊 · {publicQuestions}問</small></b><em>自分の練習に追加済みの問題です</em></span><ArrowRight size={17}/></button>
        </div>
        <p className={styles.catalogNote}>公開カタログには{publicTopics.length}冊が見えます。未追加の{publicTopics.length - adoptedCount}冊は、まだこのユーザーの練習に出ません。<button type="button" onClick={() => setView('public')}>公開カタログを見る<ArrowRight size={14}/></button></p>
        <section className={styles.practice} aria-labelledby="preview-practice-title">
          <div><p className={styles.eyebrow}>いつもの問題で、解く流れを確認</p><h2 id="preview-practice-title">今日の10問を試してみる</h2><p>実際の学習履歴をもとに、新しい問題と復習を選びます。10問未満なら、出題できる分だけ始めます。</p></div>
          <button type="button" className="button primary" disabled={!available.length} onClick={() => c.actions.startPractice('daily')}>{available.length ? `${available.length}問の練習をはじめる` : '今出題できる問題はありません'}<ArrowRight size={17}/></button>
          {!available.length && <p className={styles.noQuestions}>{c.data.questions.length ? '今日正解した問題は、日を空けると復習に出ます。問題集の保存内容は「問題集を見る」から確認できます。' : '本人の問題集が保存されるか、本人が公開問題集を学習に追加すると、ここから解けるようになります。'}</p>}
          <div className={styles.secondary}><button type="button" className="text-button" disabled={!weak.length} onClick={() => c.actions.startPractice('weak')}><RefreshCw size={15}/>間違えた問題を復習{weak.length ? `（最大${weak.length}問）` : '（対象なし）'}</button><small>この画面での練習結果は、プレビュー内だけに反映されます。</small></div>
        </section>
        <ol className={styles.flow} aria-label="問題を解く流れ"><li><span>1</span><div><strong>答えをひとつ選ぶ</strong><p>本人と同じ問題文・選択肢が表示されます。</p></div></li><li><span>2</span><div><strong>選んだら正解と解説を見る</strong><p>標準では選ぶとすぐ表示します。開始前に答え合わせボタンを使う方法にも切り替えられます。</p></div></li><li><span>3</span><div><strong>次の問題へ進む</strong><p>最後に今回の結果が表示されます。</p></div></li></ol>
      </>}
  </div>;
}
