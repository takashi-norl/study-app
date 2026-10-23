import 'server-only';
import type { Profile, StudyData } from '@/lib/types';
import type { StudyEvent } from './google-store';
import { canAccessSource } from './access';
import { ApiError } from './config';
import { getFamilyId } from './env';
import { analysisSchema, sourceAnalysisRevisionSchema, sourceAnalysisUpdateSchema } from './source-analysis-schema';
import type { z } from 'zod';

/** Sheet row order is authoritative. A fixed revision slot makes concurrent edits first-writer-wins. */
export function latestSourceAnalysis(events: StudyEvent[], sourceId: string): StudyEvent | undefined {
  const baseId = `source-analysis:${sourceId}`;
  const seen = new Set<string>();
  let current: StudyEvent | undefined;
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.type !== 'source.analysis' || event.payload.sourceId !== sourceId || typeof event.payload.text !== 'string') continue;
    if (event.id === baseId && !current && event.payload.revision === undefined && event.payload.reviewed === undefined) { current = event; continue; }
    const revision = sourceAnalysisRevisionSchema.safeParse(event.payload);
    if (!revision.success || event.id !== `${baseId}:revision:${revision.data.revision}`
      || revision.data.previousRevision !== (current?.id ?? null)
      || revision.data.revision !== (current?.payload.revision ?? 0) + 1) continue;
    current = event;
  }
  return current;
}

export function sourceAnalysisView(events: StudyEvent[], sourceId: string) {
  const saved = latestSourceAnalysis(events, sourceId);
  if (!saved) return { sourceId, revision: null, analysis: null, reviewed: false };
  let analysis: z.infer<typeof analysisSchema>;
  try { analysis = analysisSchema.parse(JSON.parse(saved.payload.text)); }
  catch {
    // Keep legacy malformed text visible for correction instead of silently inventing an extraction.
    analysis = { text: saved.payload.text, learningPoints: [], uncertainties: ['保存済みの読み取り形式を原本と見比べて確認してください。'] };
  }
  return { sourceId, revision: saved.id, analysis, updatedAt: saved.createdAt, reviewed: saved.payload.reviewed === true };
}

export function requireSourceAnalysisAccess(data: StudyData, profile: Profile, sourceId: string) {
  const member = data.profiles.find(item => item.id === profile.id && item.familyId === getFamilyId());
  if (profile.familyId !== getFamilyId() || !member || member.role !== profile.role) {
    throw new ApiError(403, 'この教材の読み取りを確認する権限がありません。', 'SOURCE_ANALYSIS_FORBIDDEN');
  }
  const source = data.sources.find(item => item.id === sourceId && item.storagePath);
  if (!source || !canAccessSource(source, member)) throw new ApiError(404, '教材が見つかりません。', 'SOURCE_NOT_FOUND');
  return source;
}

export function prepareSourceAnalysisUpdate(data: StudyData, events: StudyEvent[], profile: Profile, sourceId: string,
  input: z.infer<typeof sourceAnalysisUpdateSchema>, now = new Date()): { event?: StudyEvent; view: ReturnType<typeof sourceAnalysisView> } {
  requireSourceAnalysisAccess(data, profile, sourceId);
  const parsed = sourceAnalysisUpdateSchema.parse(input);
  const analysis = analysisSchema.parse(parsed);
  const serialized = JSON.stringify(analysis);
  const previous = events.find(event => event.type === 'source.analysis' && event.payload.requestId === parsed.requestId);
  if (previous) {
    if (previous.payload.sourceId !== sourceId || previous.actorId !== profile.id || previous.payload.previousRevision !== parsed.expectedRevision || previous.payload.text !== serialized) {
      throw new ApiError(409, 'この保存番号は別の変更に使われています。読み取りを開き直してください。', 'SOURCE_ANALYSIS_REQUEST_CONFLICT');
    }
    const current = latestSourceAnalysis(events, sourceId);
    if (current?.id !== previous.id || current.payload.requestId !== parsed.requestId) throw new ApiError(409, '別の画面で読み取りが更新されました。最新の内容を確認してください。', 'SOURCE_ANALYSIS_CONFLICT');
    return { view: sourceAnalysisView(events, sourceId) };
  }
  const current = latestSourceAnalysis(events, sourceId);
  if ((current?.id ?? null) !== parsed.expectedRevision) throw new ApiError(409, '別の画面で読み取りが更新されました。最新の内容を確認してください。', 'SOURCE_ANALYSIS_CONFLICT');
  const active = (status: string) => status === 'queued' || status === 'running';
  const activePlanIds = new Set(data.plans.filter(plan => plan.sourceIds.includes(sourceId)).map(plan => plan.id));
  if (data.planningTurns.some(turn => active(turn.status) && activePlanIds.has(turn.planId))
    || data.jobs.some(job => active(job.status) && (job.sourceIds?.includes(sourceId) || (job.planId && activePlanIds.has(job.planId))
      || (!job.sourceIds && data.sources.some(source => source.id === sourceId && source.topicId === job.topicId))))) {
    throw new ApiError(409, 'この教材を使ったAI処理が進行中です。完了後に読み取りを修正してください。', 'SOURCE_ANALYSIS_ACTIVE');
  }
  const revision = (current?.payload.revision ?? 0) + 1;
  const event: StudyEvent = { id: `source-analysis:${sourceId}:revision:${revision}`, type: 'source.analysis', actorId: profile.id,
    createdAt: now.toISOString(), payload: { sourceId, text: serialized, revision, previousRevision: current?.id ?? null, requestId: parsed.requestId, reviewed: true } };
  return { event, view: sourceAnalysisView([...events, event], sourceId) };
}

/** Samples based on an earlier reading must be remade before approving a new paid set. */
export function sourceAnalysesChangedSince(events: StudyEvent[], sourceIds: string[], proposalCreatedAt: string): boolean {
  const time = Date.parse(proposalCreatedAt);
  return sourceIds.some(sourceId => {
    const saved = latestSourceAnalysis(events, sourceId);
    return saved?.payload.reviewed === true && Date.parse(saved.createdAt) >= time;
  });
}

export function assertSourceAnalysesCurrent(events: StudyEvent[], sourceIds: string[], proposalCreatedAt: string) {
  if (sourceAnalysesChangedSince(events, sourceIds, proposalCreatedAt)) {
    throw new ApiError(409, '教材の読み取りが修正されています。AIにもう一度3問を作ってもらい、内容を確認してから本作成へ進んでください。', 'SOURCE_ANALYSIS_CHANGED');
  }
}
