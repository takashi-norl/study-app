import 'server-only';
import { randomUUID } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type {
  Attempt, Exposure, GenerationJob, LearningPlan, PlanningTurn, PracticeSession, Profile, Question, SourceDocument, StudyData, Topic,
} from '@/lib/types';
import { ApiError, MAX_SOURCE_BYTES, SOURCE_MIME_TYPES } from './config';
import { assertStorageGrant, getDriveConfig, getFamilyId, getFamilyMembers, profileForMember } from './env';
import { canAccessPlan, canAccessQuestion, canAccessSource } from './access';
import { asPracticeQuestion, isPracticeReadyQuestion, topicOwnerId } from '@/lib/library-policy';
import { libraryRevision } from './library';
import { planningSamplesSchema, planningSampleSchema } from './planning-samples';
import { aiRequestedSchema, aiUsageSchema } from './ai-usage-schema';
import { vocabularyLookupSchema } from './vocabulary-lookup-schemas';
import { audioSegmentsSchema } from './audio-segments';
import { personalProfileSavedEventSchema, personalProfileChatRequestedEventSchema, personalProfileChatCompletedEventSchema, personalProfileChatFailedEventSchema } from './personal-profile-schemas';
import { planTagsSchema } from './plan-tags';
import { sourceAnalysisRevisionSchema } from './source-analysis-schema';

const EVENT_TYPES = [
  'topic.created', 'source.created', 'question.upserted', 'questions.published', 'session.created',
  'session.completed', 'attempt.recorded', 'exposure.recorded', 'job.upserted', 'push.subscribed',
  'generation.batch', 'generation.requested', 'source.analysis',
  'plan.created', 'plan.updated', 'planning.turn.upserted',
  'audio.requested', 'audio.ready', 'audio.failed',
  'library.questions', 'library.published', 'library.adopted', 'library.publication-requested',
  'ai.requested', 'ai.usage',
  'personal-profile.saved', 'personal-profile.chat.requested', 'personal-profile.chat.completed', 'personal-profile.chat.failed',
  'vocabulary.lookup',
] as const;
export type StudyEventType = typeof EVENT_TYPES[number];
export interface StudyEvent {
  id: string; type: StudyEventType; actorId: string; familyId?: string; createdAt: string; payload: any;
}

const idSchema = z.string().min(1).max(200);
const isoSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'Invalid date');
const subjectSchema = z.string().trim().min(1).max(40);
const questionSchema = z.object({
  id: idSchema, topicId: idSchema, prompt: z.string(), choices: z.array(z.string()).min(2).max(10),
  correctIndex: z.number().int().min(0), explanation: z.string(), learningPoint: z.string(),
  sourceIds: z.array(z.string()), sourceNote: z.string(), status: z.enum(['draft', 'approved', 'published', 'archived']),
  version: z.number().int().min(1), createdAt: isoSchema, publishedAt: isoSchema.optional(), needsReview: z.boolean().optional(),
  audienceUserId: idSchema.optional(), planId: idSchema.optional(), ownerId:idSchema.optional(), aiGenerated:z.boolean().optional(),
  testOnly:z.boolean().optional(),
}).refine((question) => question.correctIndex < question.choices.length, 'Invalid answer');
const topicSchema = z.object({
  questionTemplate: z.literal('kobun-vocabulary').optional(), id: idSchema, title: z.string(), subject: subjectSchema,
  description: z.string(), createdAt: isoSchema, targetCount: z.number().int().min(0),
  audienceUserId: idSchema.optional(), planId: idSchema.optional(),testOnly:z.boolean().optional(),
  libraryPublished:z.boolean().optional(),librarySourceTopicId:idSchema.optional(), ownerId:idSchema.optional(),
  publicationRequest:z.object({requestedBy:idSchema,requestedAt:isoSchema,revision:z.string().length(64),sequence:z.number().int().positive()}).optional(),
  currentSourceRevision:z.string().length(64).optional(),publishedSourceRevision:z.string().length(64).optional(),libraryRevision:z.string().length(64).optional() });
const sourceSchema = z.object({ id: idSchema, topicId: idSchema.optional(), ownerId: idSchema.optional(), name: z.string(), mimeType: z.string(),
  storagePath: z.string().optional(), previewUrl: z.string().optional(), createdAt: isoSchema,testOnly:z.boolean().optional() });
const sessionSchema = z.object({ id: idSchema, userId: idSchema, mode: z.enum(['daily', 'extra', 'weak']),
  questionIds: z.array(idSchema).min(1), createdAt: isoSchema, completedAt: isoSchema.optional(),
  questionSnapshots: z.array(questionSchema).min(1) });
const attemptSchema = z.object({ id: idSchema, userId: idSchema, questionId: idSchema, questionVersion: z.number().int().min(1),
  sessionId: idSchema, selectedIndex: z.number().int().min(0), correct: z.boolean(), answeredAt: isoSchema });
const exposureSchema = z.object({ id: idSchema, userId: idSchema, questionId: idSchema, questionVersion: z.number().int().min(1),
  sessionId: idSchema, shownAt: isoSchema });
const jobSchema = z.object({
  questionTemplate: z.literal('kobun-vocabulary').optional(), id: idSchema, topicId: idSchema, status: z.enum(['queued', 'running', 'review', 'failed']),
  targetCount: z.number().int().min(0), generatedCount: z.number().int().min(0), createdAt: isoSchema, error: z.string().optional(),
  audienceUserId: idSchema.optional(), planId: idSchema.optional(), sourceIds: z.array(idSchema).max(20).optional(),
  instructions: z.string().max(4000).optional(), requestedBy: idSchema.optional(), proposalId: idSchema.optional(),
  turnId: idSchema.optional(), requestId: idSchema.optional(), retryOfJobId: idSchema.optional(),testOnly:z.boolean().optional(),
  approvedSamples:planningSamplesSchema.optional(),approvedSampleVersion:z.number().int().positive().optional(),approvedInstructions:z.string().min(1).max(4000).optional(),
  dailyQuestionTarget:z.number().int().min(1).max(100).optional(),plannedDays:z.number().int().min(1).max(300).optional() });
const planSchema = z.object({
  questionTemplate: z.literal('kobun-vocabulary').optional(),
  id: idSchema, ownerId: idSchema, title: z.string().trim().min(1).max(150), subject: subjectSchema,
  tags: planTagsSchema.optional(),
  goal: z.string().max(4000), difficulty: z.string().max(200), targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dailyQuestionTarget: z.number().int().min(1).max(100), sourceIds: z.array(idSchema).max(20),
  requestedQuestionCount: z.number().int().min(1).max(300).optional(),
  testOnly:z.boolean().optional(),libraryTopicId:idSchema.optional(),
  sampleFirst:z.boolean().optional(),arrangedFromTopicId:idSchema.optional(),arrangementExamples:z.array(planningSampleSchema).max(3).optional(),arrangementInstructions:z.string().max(4000).optional(),plannedDays:z.number().int().min(1).max(300).optional(),
  version: z.number().int().min(1), createdAt: isoSchema, updatedAt: isoSchema,
});
const planTagsEventSchema = planSchema.extend({ tags: planTagsSchema, tagsOnly: z.literal(true) }).strict();
const proposalSchema = z.object({
  id: idSchema, title: z.string().trim().min(1).max(150), subject: subjectSchema,
  description: z.string().max(2000), instructions: z.string().max(4000), difficulty: z.string().max(200),
  targetCount: z.number().int().min(1).max(300), format: z.literal('multiple-choice'), sourceIds: z.array(idSchema).max(20), samples:planningSamplesSchema.optional(),
});
const planningTurnSchema = z.object({
  id: idSchema, planId: idSchema, requestedBy: idSchema, version: z.number().int().min(1),
  samplePreview:z.boolean().optional(),status: z.enum(['queued', 'running', 'complete', 'failed']), message: z.string().min(1).max(4000),
  reply: z.string().max(12000).optional(), proposals: z.array(proposalSchema).max(5).optional(),
  createdAt: isoSchema, completedAt: isoSchema.optional(), error: z.string().max(1000).optional(),
  startedAt: isoSchema.optional(), updatedAt: isoSchema.optional(), workflowRunId: idSchema.optional(),
  progress: z.object({
    phase: z.enum(['queued', 'preparing', 'reading_sources', 'thinking', 'saving', 'complete', 'failed']),
    sourcesCompleted: z.number().int().min(0).max(20), sourcesTotal: z.number().int().min(0).max(20),
    sourcesRequiringAnalysis: z.number().int().min(0).max(20).optional(),
    readingSample: z.object({ count: z.number().int().min(1).max(20),
      minSeconds: z.number().finite().positive(), maxSeconds: z.number().finite().positive(),
    }).refine(sample => sample.minSeconds <= sample.maxSeconds).optional(),
  }).refine(progress => progress.sourcesCompleted <= progress.sourcesTotal
    && (progress.sourcesRequiringAnalysis === undefined || progress.sourcesRequiringAnalysis <= progress.sourcesTotal)
    && (!progress.readingSample || progress.readingSample.count <= progress.sourcesCompleted)).optional(),
});

const CELL_CHARS = 40_000;
const PAYLOAD_CELLS = 8;
let oauthClient: OAuth2Client | undefined;
let oauthKey = '';
let verifiedAccessToken = '';

function client(): OAuth2Client {
  const config = getDriveConfig();
  const key = `${config.clientId}:${config.clientSecret}:${config.refreshToken}:${config.ownerEmail ?? ''}`;
  if (!oauthClient || oauthKey !== key) {
    oauthClient = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret,
      transporterOptions: { timeout: 20_000, retryConfig: { retry: 0 } } });
    oauthClient.setCredentials({ refresh_token: config.refreshToken });
    oauthKey = key;
    verifiedAccessToken = '';
  }
  return oauthClient;
}

/** Internal only: no caller can provide an arbitrary host, path or bearer token through an API. */
async function googleFetch(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['www.googleapis.com', 'sheets.googleapis.com'].includes(parsed.hostname)) {
    throw new ApiError(500, 'Googleの接続先が不正です。', 'INVALID_GOOGLE_ENDPOINT');
  }
  for (let index = 0; index < 3; index += 1) {
    let response: Response;
    try {
      const token = await client().getAccessToken();
      if (!token.token) throw new Error('Missing access token');
      if (verifiedAccessToken !== token.token) {
        const info = await client().getTokenInfo(token.token);
        assertStorageGrant(info, getDriveConfig());
        verifiedAccessToken = token.token;
      }
      response = await fetch(url, { ...init, redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1), 180_000)),
        headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${token.token}` } });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 400 || status === 401 || status === 403) {
        throw new ApiError(503, '保存用Google接続の期限・権限を確認し、必要に応じて所有者が再接続してください。', 'GOOGLE_AUTH_EXPIRED');
      }
      if (index === 2) throw new ApiError(502, 'Google Driveに接続できません。しばらくして再試行してください。', 'GOOGLE_UNAVAILABLE');
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** index));
      continue;
    }
    if (response.ok) return response;
    if ((response.status === 429 || response.status >= 500) && index < 2) {
      await response.body?.cancel();
      const delay = Math.min(3_000, Math.max(500 * 2 ** index, Number(response.headers.get('retry-after') || 0) * 1000));
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const code = response.status === 401 || response.status === 403 ? 'GOOGLE_ACCESS_DENIED' : 'GOOGLE_REQUEST_FAILED';
    await response.body?.cancel();
    throw new ApiError(response.status === 429 ? 429 : 502,
      code === 'GOOGLE_ACCESS_DENIED' ? 'Google Driveの接続権限と保存先の許可を確認してください。' : 'Google Driveの読み書きに失敗しました。', code);
  }
  throw new ApiError(502, 'Google Driveへの接続に失敗しました。', 'GOOGLE_UNAVAILABLE');
}

function validateEvent(input: StudyEvent): StudyEvent {
  const metadata = z.object({ id: idSchema, type: z.enum(EVENT_TYPES), actorId: idSchema,
    familyId: z.string().optional(), createdAt: isoSchema }).parse(input);
  if (metadata.familyId && metadata.familyId !== getFamilyId()) throw new ApiError(403, '別の家族の記録にはアクセスできません。', 'FAMILY_MISMATCH');
  const payload = input.payload;
  switch (metadata.type) {
    case 'vocabulary.lookup': vocabularyLookupSchema.parse(payload); break;
    case 'ai.requested': aiRequestedSchema.parse(payload); break;
    case 'ai.usage': aiUsageSchema.parse(payload); break;
    case 'personal-profile.saved': personalProfileSavedEventSchema.parse(payload); break;
    case 'personal-profile.chat.requested': personalProfileChatRequestedEventSchema.parse(payload); break;
    case 'personal-profile.chat.completed': personalProfileChatCompletedEventSchema.parse(payload); break;
    case 'personal-profile.chat.failed': personalProfileChatFailedEventSchema.parse(payload); break;
    case 'topic.created': topicSchema.parse(payload); break;
    case 'source.created': sourceSchema.parse(payload); break;
    case 'question.upserted': questionSchema.parse(payload); break;
    case 'questions.published': z.object({ questions: z.array(questionSchema) }).parse(payload); break;
    case 'session.created': {
      const session = sessionSchema.parse(payload);
      const ids = new Set(session.questionIds);
      if (ids.size !== session.questionIds.length || ids.size !== session.questionSnapshots.length
        || new Set(session.questionSnapshots.map((question) => question.id)).size !== ids.size
        || session.questionSnapshots.some((question) => !ids.has(question.id))) throw new ApiError(400, '出題内容が一致しません。', 'INVALID_SESSION');
      break;
    }
    case 'session.completed': z.object({ sessionId: idSchema, completedAt: isoSchema }).parse(payload); break;
    case 'attempt.recorded': attemptSchema.parse(payload); break;
    case 'exposure.recorded': exposureSchema.parse(payload); break;
    case 'job.upserted': jobSchema.parse(payload); break;
    case 'generation.requested': {
      const requested = z.object({ topic: topicSchema, job: jobSchema, updatedPlan:planSchema.optional() }).parse(payload);
      if (requested.topic.id !== requested.job.topicId
        || requested.topic.audienceUserId !== requested.job.audienceUserId
        || !!requested.topic.testOnly !== !!requested.job.testOnly
        || requested.topic.planId !== requested.job.planId) throw new ApiError(400, '作問する問題集の指定が一致しません。', 'INVALID_GENERATION');
      if(requested.updatedPlan && (requested.updatedPlan.id!==requested.job.planId || requested.updatedPlan.ownerId!==requested.job.requestedBy)) throw new ApiError(400,'学習プランの作成者が一致しません。','INVALID_GENERATION');
      break;
    }
    case 'plan.created': planSchema.parse(payload); break;
    case 'plan.updated':
      if (payload?.tagsOnly !== undefined) planTagsEventSchema.parse(payload);
      else planSchema.parse(payload);
      break;
    case 'library.publication-requested': {
      const pending=z.object({sourceTopicId:idSchema,requestedBy:idSchema,requestedAt:isoSchema,revision:z.string().length(64),sequence:z.number().int().positive()}).strict().parse(payload);
      if(pending.requestedBy!==metadata.actorId) throw new ApiError(400,'公開依頼者が一致しません。','INVALID_LIBRARY');
      break;
    }
    case 'library.questions': {
      const batch=z.object({topicId:idSchema,questions:z.array(questionSchema).min(1).max(300)}).parse(payload);
      if(batch.questions.some(question=>question.topicId!==batch.topicId || question.testOnly || question.audienceUserId || question.ownerId || question.planId || question.sourceIds.length || question.status!=='published')) throw new ApiError(400,'ライブラリへの公開内容を確認してください。','INVALID_LIBRARY');
      break;
    }
    case 'library.published': {
      const published=z.object({sourceTopicId:idSchema,topic:topicSchema,questionIds:z.array(idSchema).min(1).max(300)}).parse(payload);
      if(!published.topic.libraryPublished || published.topic.testOnly || published.topic.audienceUserId || published.topic.ownerId || published.topic.publicationRequest || published.topic.planId
        || published.topic.librarySourceTopicId!==published.sourceTopicId
        || new Set(published.questionIds).size!==published.questionIds.length) {
        throw new ApiError(400,'ライブラリへの公開内容を確認してください。','INVALID_LIBRARY');
      }
      break;
    }
    case 'library.adopted': {
      const plan=planSchema.parse(payload);
      if(!plan.libraryTopicId || plan.testOnly || plan.sourceIds.length) throw new ApiError(400,'ライブラリの追加内容を確認してください。','INVALID_LIBRARY');
      break;
    }
    case 'planning.turn.upserted': planningTurnSchema.parse(payload); break;
    case 'generation.batch': z.object({ jobId: idSchema, batch: z.number().int().min(0),
      questions: z.array(questionSchema), job: jobSchema }).parse(payload); break;
    case 'source.analysis':
      if ('revision' in payload || 'reviewed' in payload || 'previousRevision' in payload) sourceAnalysisRevisionSchema.parse(payload);
      else z.object({ sourceId: idSchema, text: z.string().max(100_000) }).parse(payload);
      break;
    case 'audio.requested': z.object({cacheKey:z.string().regex(/^[a-f0-9]{64}$/),requestToken:z.string().uuid(),characters:z.number().int().min(1).max(1500)}).strict().parse(payload); break;
    case 'audio.ready': z.object({cacheKey:z.string().regex(/^[a-f0-9]{64}$/),requestToken:z.string().uuid(),fileId:idSchema,segments:audioSegmentsSchema.optional()}).strict().parse(payload); break;
    case 'audio.failed': z.object({cacheKey:z.string().regex(/^[a-f0-9]{64}$/),requestToken:z.string().uuid()}).strict().parse(payload); break;
    case 'push.subscribed': z.object({ userId: idSchema, subscription: z.object({ endpoint: z.string().url(),
      keys: z.object({ auth: z.string(), p256dh: z.string() }) }).nullable() }).parse(payload); break;
  }
  return { ...metadata, familyId: getFamilyId(), payload };
}

function sheetRange(): string {
  return `${getDriveConfig().tab}!A:M`;
}

/** Rows are append-only. The Google row order, not client timestamps, is the event order. */
export async function loadEvents(): Promise<StudyEvent[]> {
  const config = getDriveConfig();
  const response = await googleFetch(`https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${encodeURIComponent(sheetRange())}?valueRenderOption=UNFORMATTED_VALUE`);
  const body = await response.json() as { values?: unknown[][] };
  const result: StudyEvent[] = [];
  const seen = new Set<string>();
  for (const [index, row] of (body.values ?? []).entries()) {
    if (!row.some((value) => value !== '')) continue;
    if (index === 0 && ['id', 'eventId'].includes(String(row[0]))) continue;
    try {
      const [id, type, actorId, familyId, createdAt] = row;
      if (typeof id !== 'string' || typeof type !== 'string' || typeof actorId !== 'string'
        || typeof familyId !== 'string' || typeof createdAt !== 'string') throw new Error('Invalid event row');
      const payload = JSON.parse(row.slice(5, 5 + PAYLOAD_CELLS).map((part) => String(part ?? '')).join(''));
      const event = validateEvent({ id, type: type as StudyEventType, actorId, familyId, createdAt, payload });
      if (!seen.has(event.id)) { result.push(event); seen.add(event.id); }
    } catch {
      throw new ApiError(502, `学習記録の${index + 1}行目を読み取れません。記録シートを確認してください。`, 'INVALID_EVENT_LOG');
    }
  }
  return result;
}

/** Retrying an append may create a duplicate row; stable event IDs make replay idempotent. */
export async function appendEvents(events: StudyEvent[]): Promise<void> {
  if (!events.length) return;
  if (events.length > 100) throw new ApiError(413, '一度に保存する件数が多すぎます。', 'EVENT_BATCH_TOO_LARGE');
  const config = getDriveConfig();
  const values = events.map((input) => {
    const event = validateEvent(input);
    const serialized = JSON.stringify(event.payload);
    if (serialized.length > CELL_CHARS * PAYLOAD_CELLS) throw new ApiError(413, '保存する内容が大きすぎます。問題数を減らしてください。', 'EVENT_TOO_LARGE');
    const chunks: string[] = [];
    for (let offset = 0; offset < serialized.length;) {
      let end = Math.min(offset + CELL_CHARS, serialized.length);
      // Keep a supplementary Unicode character together across spreadsheet cell boundaries.
      if (end < serialized.length && /[\uD800-\uDBFF]/.test(serialized[end - 1]) && /[\uDC00-\uDFFF]/.test(serialized[end])) end -= 1;
      chunks.push(serialized.slice(offset, end));
      offset = end;
    }
    if (chunks.length > PAYLOAD_CELLS) throw new ApiError(413, '保存する内容が大きすぎます。問題数を減らしてください。', 'EVENT_TOO_LARGE');
    while (chunks.length < PAYLOAD_CELLS) chunks.push('');
    return [event.id, event.type, event.actorId, event.familyId, event.createdAt, ...chunks];
  });
  const body = JSON.stringify({ majorDimension: 'ROWS', values });
  if (Buffer.byteLength(body, 'utf8') > 1_500_000) throw new ApiError(413, '一度に保存する内容が大きすぎます。分けて保存してください。', 'EVENT_BATCH_TOO_LARGE');
  const response = await googleFetch(`https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${encodeURIComponent(sheetRange())}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  await response.body?.cancel();
}

export async function appendEvent(event: StudyEvent): Promise<void> { return appendEvents([event]); }

export function foldEvents(events: StudyEvent[], profiles: Profile[] = []): StudyData {
  const topics = new Map<string, Topic>();
  const sources = new Map<string, SourceDocument>();
  const questions = new Map<string, Question>();
  const sessions = new Map<string, PracticeSession>();
  const snapshots = new Map<string, Question[]>();
  const attempts = new Map<string, Attempt>();
  const exposures = new Map<string, Exposure>();
  const jobs = new Map<string, GenerationJob>();
  const plans = new Map<string, LearningPlan>();
  const libraryQuestions=new Map<string,Question>();
  const planningTurns = new Map<string, PlanningTurn>();
  const planVersions = new Set<string>();
  const eventIds = new Set<string>();
  const upsertQuestion = (question: Question) => {
    const current = questions.get(question.id);
    if (!current || question.version > current.version) questions.set(question.id, structuredClone(question));
  };
  for (const input of events) {
    if (eventIds.has(input.id)) continue;
    const event = validateEvent(input);
    eventIds.add(event.id);
    const payload = event.payload;
    switch (event.type) {
      case 'topic.created': if (!topics.has(payload.id)) topics.set(payload.id, { ...topicSchema.parse(payload), ownerId:payload.ownerId ?? payload.audienceUserId ?? event.actorId }); break;
      case 'source.created': if (!sources.has(payload.id)) sources.set(payload.id, sourceSchema.parse(payload)); break;
      case 'question.upserted': upsertQuestion(questionSchema.parse(payload)); break;
      case 'questions.published': for (const question of payload.questions) upsertQuestion(questionSchema.parse(question)); break;
      case 'session.created': {
        const session = sessionSchema.parse(payload);
        if (!sessions.has(session.id)) {
          const { questionSnapshots, ...stored } = session;
          sessions.set(stored.id, stored);
          snapshots.set(stored.id, questionSnapshots);
        }
        break;
      }
      case 'attempt.recorded': {
        const attempt = attemptSchema.parse(payload);
        const session = sessions.get(attempt.sessionId);
        const question = snapshots.get(attempt.sessionId)?.find((entry) => entry.id === attempt.questionId);
        // The canonical first answer wins even if two requests read the same earlier sheet state.
        const key = JSON.stringify([attempt.userId, attempt.sessionId, attempt.questionId]);
        if (!attempts.has(key) && session?.userId === attempt.userId && question
          && question.version === attempt.questionVersion && attempt.selectedIndex < question.choices.length) {
          attempts.set(key, { ...attempt, correct: attempt.selectedIndex === question.correctIndex });
        }
        break;
      }
      case 'exposure.recorded': {
        const exposure = exposureSchema.parse(payload);
        const session = sessions.get(exposure.sessionId);
        const question = snapshots.get(exposure.sessionId)?.find((entry) => entry.id === exposure.questionId);
        const key = JSON.stringify([exposure.userId, exposure.sessionId, exposure.questionId]);
        if (!exposures.has(key) && session?.userId === exposure.userId && question?.version === exposure.questionVersion) exposures.set(key, exposure);
        break;
      }
      case 'job.upserted': jobs.set(payload.id, jobSchema.parse(payload)); break;
      case 'generation.requested': {
        const topic = topicSchema.parse(payload.topic);
        const job = jobSchema.parse(payload.job);
        if (!topics.has(topic.id) && !jobs.has(job.id)) {
          topics.set(topic.id, { ...topic, ownerId:topic.ownerId ?? job.requestedBy ?? topic.audienceUserId ?? event.actorId });
          jobs.set(job.id, job);
          if(payload.updatedPlan) {
            const updated=planSchema.parse(payload.updatedPlan);
            const previous=plans.get(updated.id);
            if(previous && previous.ownerId===updated.ownerId && updated.version===previous.version+1) plans.set(updated.id,{...updated,tags:previous.tags});
          }
        }
        break;
      }
      case 'plan.created': if (!plans.has(payload.id)) plans.set(payload.id, planSchema.parse(payload)); break;
      case 'library.publication-requested': {
        const topic=topics.get(payload.sourceTopicId);
        const ownerId=plans.get(topic?.planId ?? '')?.ownerId ?? topic?.ownerId ?? [...jobs.values()].find(job=>job.topicId===topic?.id)?.requestedBy ?? topic?.audienceUserId;
        if(topic && !topic.libraryPublished && !topic.testOnly && ownerId===event.actorId && payload.sequence===(topic.publicationRequest?.sequence ?? 0)+1) topics.set(topic.id,{...topic,publicationRequest:{requestedBy:payload.requestedBy,requestedAt:payload.requestedAt,revision:payload.revision,sequence:payload.sequence}});
        break;
      }
      case 'library.questions': for(const item of payload.questions) {if(!libraryQuestions.has(item.id)) libraryQuestions.set(item.id,questionSchema.parse(item));} break;
      case 'library.published': {
        const topic=topicSchema.parse(payload.topic);
        const published=payload.questionIds.map((id:string)=>libraryQuestions.get(id)) as (Question|undefined)[];
        if(!topics.has(topic.id) && published.every(question=>question?.topicId===topic.id)) {
          topics.set(topic.id,topic);
          for(const question of published) upsertQuestion(question!);
        }
        break;
      }
      case 'library.adopted': {
        const plan=planSchema.parse(payload);
        if(topics.get(plan.libraryTopicId!)?.libraryPublished && ![...plans.values()].some(item=>item.ownerId===plan.ownerId && item.libraryTopicId===plan.libraryTopicId)) plans.set(plan.id,plan);
        break;
      }
      case 'plan.updated': {
        const plan = planSchema.parse(payload);
        const previous = plans.get(plan.id);
        if (payload.tagsOnly === true) {
          const owner = profiles.find(profile => profile.id === event.actorId && profile.familyId === getFamilyId());
          // An in-flight AI update may already have advanced the version. Never replace its content.
          if (previous && owner && plan.ownerId === previous.ownerId && event.actorId === previous.ownerId
            && plan.version <= previous.version && (!previous.testOnly || owner.role === 'parent')) {
            plans.set(previous.id, { ...previous, tags: plan.tags, updatedAt: event.createdAt });
          }
        } else if (previous && plan.ownerId === previous.ownerId && plan.version > previous.version) {
          plans.set(plan.id, { ...plan, tags: previous.tags });
        }
        break;
      }
      case 'planning.turn.upserted': {
        const turn = planningTurnSchema.parse(payload);
        const plan = plans.get(turn.planId);
        if (!plan || turn.requestedBy !== plan.ownerId) break;
        const previous = planningTurns.get(turn.id);
        if (!previous) {
          const slot = JSON.stringify([turn.planId, turn.version]);
          if (turn.status !== 'queued' || turn.version !== plan.version + 1 || planVersions.has(slot)) break;
          planVersions.add(slot);
          planningTurns.set(turn.id, turn);
          plans.set(plan.id, { ...plan, version: turn.version, updatedAt: turn.createdAt });
        } else if (previous.planId === turn.planId && previous.version === turn.version
          && previous.status !== 'complete' && previous.status !== 'failed'
          && !(previous.status === 'running' && turn.status === 'queued')) {
          // An old progress write must not move a newer running phase backwards.
          if (turn.status === 'running' && turn.updatedAt && previous.updatedAt
            && Date.parse(turn.updatedAt) < Date.parse(previous.updatedAt)) break;
          planningTurns.set(turn.id, { ...turn, message: previous.message, createdAt: previous.createdAt,samplePreview:previous.samplePreview,
            startedAt: previous.startedAt ?? turn.startedAt, updatedAt: turn.updatedAt ?? previous.updatedAt,
            workflowRunId: previous.workflowRunId ?? turn.workflowRunId,
            progress: turn.progress ? { ...turn.progress,
              sourcesRequiringAnalysis: previous.progress?.sourcesRequiringAnalysis ?? turn.progress.sourcesRequiringAnalysis,
            } : previous.progress,
          });
        }
        break;
      }
      case 'generation.batch':
        for (const question of payload.questions) upsertQuestion(questionSchema.parse(question));
        jobs.set(payload.job.id, jobSchema.parse(payload.job));
        break;
      // Analyses and subscriptions remain available only to server callers through the event log.
      case 'source.analysis': case 'push.subscribed': case 'session.completed':
      case 'audio.requested': case 'audio.ready': case 'audio.failed': break;
    }
  }
  for (const session of sessions.values()) {
    const answers = session.questionIds.map((questionId) => attempts.get(JSON.stringify([session.userId, session.id, questionId])));
    if (answers.every(Boolean)) session.completedAt = answers.map((answer) => answer!.answeredAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    else delete session.completedAt;
  }
  // Ownership is derived without changing legacy audience/provenance fields used by active workflows.
  const materialized={topics:[...topics.values()],plans:[...plans.values()],jobs:[...jobs.values()]} as StudyData;
  for(const topic of topics.values()) {
    if(topic.libraryPublished) continue;
    topic.ownerId=plans.get(topic.planId ?? '')?.ownerId ?? topicOwnerId(materialized,topic);
    topic.currentSourceRevision=libraryRevision(topic,[...questions.values()]);
    const publicVersions=[...topics.values()].filter(item=>item.libraryPublished && item.librarySourceTopicId===topic.id);
    topic.publishedSourceRevision=publicVersions.find(item=>item.libraryRevision===topic.currentSourceRevision)?.libraryRevision ?? publicVersions.at(-1)?.libraryRevision;
  }
  for(const question of questions.values()) {
    const topic=topics.get(question.topicId);
    if(topic && !topic.libraryPublished) {
      question.ownerId=topic.ownerId;
      if([...jobs.values()].some(job=>job.topicId===topic.id)) question.aiGenerated=question.aiGenerated ?? true;
    }
  }
  return { topics: [...topics.values()], sources: [...sources.values()], questions: [...questions.values()],
    attempts: [...attempts.values()], exposures: [...exposures.values()], sessions: [...sessions.values()],
    jobs: [...jobs.values()], profiles: structuredClone(profiles),
    plans: [...plans.values()], planningTurns: [...planningTurns.values()] };
}

export async function getFullState(): Promise<{ data: StudyData; events: StudyEvent[] }> {
  const events = await loadEvents();
  return { data: foldEvents(events, getFamilyMembers().map(profileForMember)), events };
}

export async function getSessionSnapshot(sessionId: string, events?: StudyEvent[]): Promise<Question[]> {
  const event = (events ?? await loadEvents()).find((entry) => entry.type === 'session.created' && entry.payload.id === sessionId);
  return event ? structuredClone(sessionSchema.parse(event.payload).questionSnapshots) : [];
}

export function studyDataForProfile(data: StudyData, profile: Profile, now = new Date()): StudyData {
  if (profile.familyId !== getFamilyId()) throw new ApiError(403, '別の家族の記録にはアクセスできません。', 'FAMILY_MISMATCH');
  if (profile.role === 'parent') {
    return { ...data, sources: data.sources.map((source) => ({ ...source, previewUrl: `/api/sources/${encodeURIComponent(source.id)}` })) };
  }
  const accessibleTopics=new Map(data.topics.filter(topic=>canAccessQuestion(topic,profile)).map(topic=>[topic.id,topic]));
  const adopted=new Set(data.plans.filter(plan=>plan.ownerId===profile.id && !plan.testOnly).map(plan=>plan.libraryTopicId).filter(Boolean));
  const published = data.questions.filter((question) => canAccessQuestion(question, profile) && accessibleTopics.has(question.topicId)
    && (!accessibleTopics.get(question.topicId)?.libraryPublished || adopted.has(question.topicId)) && isPracticeReadyQuestion(question,now));
  const visibleTopics = new Set(published.map((question) => question.topicId));
  const plans = data.plans.filter((plan) => canAccessPlan(plan, profile));
  const planIds = new Set(plans.map((plan) => plan.id));
  return { ...data, topics: data.topics.filter((topic) => (visibleTopics.has(topic.id) || topic.libraryPublished || topic.ownerId===profile.id) && canAccessQuestion(topic, profile))
      .map(({librarySourceTopicId:_privateSource,...topic})=>topic),
    sources: data.sources.filter((source) => canAccessSource(source, profile))
      .map((source) => ({ ...source, previewUrl: `/api/sources/${encodeURIComponent(source.id)}` })),
    jobs: data.jobs.filter((job) => !job.testOnly && (job.requestedBy === profile.id || job.audienceUserId === profile.id) && accessibleTopics.has(job.topicId)), profiles: [profile],
    plans, planningTurns: data.planningTurns.filter((turn) => planIds.has(turn.planId)),
    questions: published.map(asPracticeQuestion)
      .map((question) => ({ id: question.id, topicId: question.topicId, prompt: question.prompt, choices: [...question.choices],
        correctIndex: -1, explanation: '', learningPoint: '', sourceNote: '', sourceIds: [],
        status: question.status, version: question.version, createdAt: question.createdAt, publishedAt: question.publishedAt,
        ownerId:question.ownerId,aiGenerated:question.aiGenerated,audienceUserId: question.audienceUserId, planId: question.planId, needsReview: question.needsReview,testOnly:question.testOnly })),
    attempts: data.attempts.filter((attempt) => attempt.userId === profile.id),
    exposures: data.exposures.filter((exposure) => exposure.userId === profile.id),
    sessions: data.sessions.filter((session) => session.userId === profile.id).map((session) => ({
      id: session.id, userId: session.userId, mode: session.mode, questionIds: [...session.questionIds],
      createdAt: session.createdAt, completedAt: session.completedAt,
    })),
  };
}

export async function loadStudyData(profile: Profile): Promise<StudyData> {
  if (profile.familyId !== getFamilyId()) throw new ApiError(403, '別の家族の記録にはアクセスできません。', 'FAMILY_MISMATCH');
  return studyDataForProfile((await getFullState()).data, profile);
}

export interface DriveFileMetadata {
  id: string; name: string; mimeType: string; size?: string; parents?: string[];
  appProperties?: Record<string, string>;
}

function requireDriveFileId(fileId: string) {
  if (!/^[a-zA-Z0-9_-]{8,200}$/.test(fileId)) throw new ApiError(400, '資料ファイルの指定が不正です。', 'INVALID_FILE_ID');
}

/** Only an app-owned source directly inside the one configured folder can be inspected or downloaded. */
export async function getDriveFileMetadata(fileId: string): Promise<DriveFileMetadata> {
  requireDriveFileId(fileId);
  const config = getDriveConfig();
  const response = await googleFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,parents,appProperties,trashed`);
  const file = await response.json() as DriveFileMetadata & { trashed?: boolean };
  if (file.trashed || !file.parents?.includes(config.folderId) || file.appProperties?.purpose !== 'hibi-study-source') {
    throw new ApiError(403, 'この資料ファイルにはアクセスできません。', 'SOURCE_ACCESS_DENIED');
  }
  return file;
}

export async function createSourceUpload(input: {
  sourceId: string; topicId?: string; ownerId: string; name: string; mimeType: string; size: number;
}, browserOrigin: string): Promise<{ uploadUrl: string; fileId: string }> {
  const config = getDriveConfig();
  if (!SOURCE_MIME_TYPES.includes(input.mimeType as typeof SOURCE_MIME_TYPES[number])
    || !Number.isInteger(input.size) || input.size <= 0 || input.size > MAX_SOURCE_BYTES) {
    throw new ApiError(400, '対応する写真・PDFを10MB以内で選択してください。', 'INVALID_SOURCE');
  }
  if (!input.name.trim() || input.name.length > 200 || input.sourceId.length > 100
    || (input.topicId !== undefined && input.topicId.length > 100) || !input.ownerId || input.ownerId.length > 100) {
    throw new ApiError(400, '資料の名前・指定を確認してください。', 'INVALID_SOURCE');
  }
  const idsResponse = await googleFetch('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files');
  const generated = await idsResponse.json() as { ids?: string[] };
  const fileId = generated.ids?.[0];
  if (!fileId) throw new ApiError(502, 'アップロードの準備に失敗しました。', 'UPLOAD_SETUP_FAILED');
  const response = await googleFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8',
      // Drive uses the initiating Origin for CORS on the final browser PUT response.
      Origin: browserOrigin,
      'X-Upload-Content-Type': input.mimeType, 'X-Upload-Content-Length': String(input.size) },
    body: JSON.stringify({ id: fileId, name: input.name, mimeType: input.mimeType, parents: [config.folderId],
      appProperties: { purpose: 'hibi-study-source', sourceId: input.sourceId, topicId: input.topicId, ownerId: input.ownerId } }),
  });
  const uploadUrl = response.headers.get('location');
  if (!uploadUrl) throw new ApiError(502, 'アップロードの準備に失敗しました。', 'UPLOAD_SETUP_FAILED');
  const destination = new URL(uploadUrl);
  if (destination.protocol !== 'https:' || destination.hostname !== 'www.googleapis.com' || !destination.pathname.startsWith('/upload/drive/')) {
    throw new ApiError(502, 'アップロードの接続先を確認できません。', 'UPLOAD_SETUP_FAILED');
  }
  // This is a single-file upload capability, not an OAuth token. Never log it or persist it in Sheets.
  return { uploadUrl, fileId };
}

/** Preserve backpressure, cap the actual body, and stop Drive when the client disconnects. */
export function createBoundedSourceStream(upstream: ReadableStream<Uint8Array>, expectedBytes: number): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_SOURCE_BYTES) {
    throw new ApiError(413, '資料のサイズが対応範囲外です。', 'INVALID_SOURCE');
  }
  const reader = upstream.getReader();
  let bytesRead = 0;
  let closed = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (closed) return;
        if (result.done) {
          closed = true;
          if (bytesRead !== expectedBytes) controller.error(new ApiError(502, '資料の転送が途中で終了しました。', 'SOURCE_TRUNCATED'));
          else controller.close();
          return;
        }
        bytesRead += result.value.byteLength;
        if (bytesRead > expectedBytes || bytesRead > MAX_SOURCE_BYTES) {
          closed = true;
          try { await reader.cancel(); } catch { /* Still report the bounded-body failure. */ }
          controller.error(new ApiError(413, '資料のサイズが対応範囲を超えました。', 'SOURCE_TOO_LARGE'));
          return;
        }
        controller.enqueue(result.value);
      } catch {
        if (closed) return;
        closed = true;
        try { await reader.cancel(); } catch { /* The upstream may already be aborted. */ }
        controller.error(new ApiError(502, '資料を転送できませんでした。再度開いてください。', 'SOURCE_DOWNLOAD_FAILED'));
      }
    },
    async cancel(reason) {
      closed = true;
      await reader.cancel(reason);
    },
  });
}

export async function streamSourceFile(fileId: string): Promise<{ stream: ReadableStream<Uint8Array>; mimeType: string; name: string }> {
  const file = await getDriveFileMetadata(fileId);
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SOURCE_BYTES
    || !SOURCE_MIME_TYPES.includes(file.mimeType as typeof SOURCE_MIME_TYPES[number])) {
    throw new ApiError(413, '資料のサイズまたは形式が対応範囲外です。', 'INVALID_SOURCE');
  }
  // Slow mobile previews can take longer than ordinary metadata or Sheets requests.
  const response = await googleFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {}, 180_000);
  if (!response.body) throw new ApiError(502, '資料を読み込めません。', 'SOURCE_DOWNLOAD_FAILED');
  return { stream: createBoundedSourceStream(response.body, size), mimeType: file.mimeType, name: file.name };
}

export async function downloadSourceFile(fileId: string): Promise<{ bytes: Uint8Array; mimeType: string; name: string }> {
  const file = await streamSourceFile(fileId);
  const reader = file.stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytesRead += result.value.byteLength;
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, mimeType: file.mimeType, name: file.name };
}

export const MAX_AUDIO_BYTES=2*1024*1024;
function requireAudioCacheKey(cacheKey:string) {
  if(!/^[a-f0-9]{64}$/.test(cacheKey)) throw new ApiError(400,'音声の指定が不正です。','INVALID_AUDIO');
}

/** Audio shares the existing app-owned folder and narrow drive.file grant, never public sharing. */
export async function downloadAudioCache(fileId:string,cacheKey:string):Promise<Uint8Array> {
  requireDriveFileId(fileId);requireAudioCacheKey(cacheKey);
  const response=await googleFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,mimeType,size,parents,appProperties,trashed`);
  const file=await response.json() as DriveFileMetadata & {trashed?:boolean};
  const size=Number(file.size);
  if(file.trashed || !file.parents?.includes(getDriveConfig().folderId) || file.appProperties?.purpose!=='hibi-study-audio'
    || file.appProperties.cacheKey!==cacheKey || file.mimeType!=='audio/mpeg' || !Number.isSafeInteger(size) || size<1 || size>MAX_AUDIO_BYTES) {
    throw new ApiError(403,'この音声にはアクセスできません。','AUDIO_ACCESS_DENIED');
  }
  const media=await googleFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  if(!media.body) throw new ApiError(502,'音声を読み込めません。','AUDIO_UNAVAILABLE');
  return new Uint8Array(await new Response(createBoundedSourceStream(media.body,size)).arrayBuffer());
}

/** Find only this app's private cache; a repeated import reuses the existing Drive object. */
export async function findAudioCache(cacheKey: string): Promise<string | null> {
  requireAudioCacheKey(cacheKey);
  const folderId = getDriveConfig().folderId;
  const query = `'${folderId}' in parents and trashed = false and mimeType = 'audio/mpeg' and appProperties has { key='purpose' and value='hibi-study-audio' } and appProperties has { key='cacheKey' and value='${cacheKey}' }`;
  const params = new URLSearchParams({ q: query, pageSize: '100', orderBy: 'createdTime', fields: 'files(id,mimeType,size,parents,appProperties,trashed)' });
  const response = await googleFetch(`https://www.googleapis.com/drive/v3/files?${params}`);
  const body = await response.json() as { files?: (DriveFileMetadata & { trashed?: boolean })[] };
  if (!Array.isArray(body.files)) throw new ApiError(502, '保存済み音声を確認できませんでした。', 'AUDIO_CACHE_FAILED');
  for (const file of body.files) {
    const size = Number(file.size);
    if (typeof file.id !== 'string' || !/^[a-zA-Z0-9_-]{8,200}$/.test(file.id)
      || file.trashed || !Array.isArray(file.parents) || !file.parents.includes(folderId) || file.mimeType !== 'audio/mpeg'
      || file.appProperties?.purpose !== 'hibi-study-audio' || file.appProperties.cacheKey !== cacheKey
      || !Number.isSafeInteger(size) || size < 1 || size > MAX_AUDIO_BYTES) continue;
    requireDriveFileId(file.id);
    return file.id;
  }
  return null;
}

export async function saveAudioCache(cacheKey:string,bytes:Uint8Array):Promise<string> {
  requireAudioCacheKey(cacheKey);
  if(!bytes.byteLength || bytes.byteLength>MAX_AUDIO_BYTES) throw new ApiError(413,'音声が長すぎます。','AUDIO_TOO_LARGE');
  const ids=await googleFetch('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files');
  const fileId=((await ids.json()) as {ids?:string[]}).ids?.[0];
  if(!fileId) throw new ApiError(502,'音声の保存を準備できません。','AUDIO_CACHE_FAILED');
  requireDriveFileId(fileId);
  const boundary=`hibi_audio_${randomUUID().replaceAll('-','')}`;
  const metadata={id:fileId,name:`音声-${cacheKey.slice(0,12)}.mp3`,mimeType:'audio/mpeg',parents:[getDriveConfig().folderId],
    appProperties:{purpose:'hibi-study-audio',cacheKey}};
  const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: audio/mpeg\r\n\r\n`),Buffer.from(bytes),Buffer.from(`\r\n--${boundary}--\r\n`)]);
  try {
    const saved=await googleFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',{
      method:'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body,
    });
    const result=await saved.json() as {id?:string};
    if(result.id!==fileId) throw new ApiError(502,'音声の保存を確認できません。','AUDIO_CACHE_FAILED');
  } catch(error) {
    // A retried create can return 409 after the first upload succeeded. Verify the preassigned file.
    try {await downloadAudioCache(fileId,cacheKey);return fileId;} catch {throw error;}
  }
  return fileId;
}
