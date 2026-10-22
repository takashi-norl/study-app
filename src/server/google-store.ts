import 'server-only';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import type {
  Attempt, Exposure, GenerationJob, PracticeSession, Profile, Question, SourceDocument, StudyData, Topic,
} from '@/lib/types';
import { ApiError, MAX_SOURCE_BYTES, SOURCE_MIME_TYPES } from './config';
import { assertStorageGrant, getDriveConfig, getFamilyId, getFamilyMembers, profileForMember } from './env';

const EVENT_TYPES = [
  'topic.created', 'source.created', 'question.upserted', 'questions.published', 'session.created',
  'session.completed', 'attempt.recorded', 'exposure.recorded', 'job.upserted', 'push.subscribed',
  'generation.batch', 'source.analysis',
] as const;
export type StudyEventType = typeof EVENT_TYPES[number];
export interface StudyEvent {
  id: string; type: StudyEventType; actorId: string; familyId?: string; createdAt: string; payload: any;
}

const idSchema = z.string().min(1).max(200);
const isoSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'Invalid date');
const questionSchema = z.object({
  id: idSchema, topicId: idSchema, prompt: z.string(), choices: z.array(z.string()).min(2).max(10),
  correctIndex: z.number().int().min(0), explanation: z.string(), learningPoint: z.string(),
  sourceIds: z.array(z.string()), sourceNote: z.string(), status: z.enum(['draft', 'approved', 'published', 'archived']),
  version: z.number().int().min(1), createdAt: isoSchema, publishedAt: isoSchema.optional(), needsReview: z.boolean().optional(),
}).refine((question) => question.correctIndex < question.choices.length, 'Invalid answer');
const topicSchema = z.object({ id: idSchema, title: z.string(), subject: z.enum(['古文', '漢文', '英語']),
  description: z.string(), createdAt: isoSchema, targetCount: z.number().int().min(0) });
const sourceSchema = z.object({ id: idSchema, topicId: idSchema, name: z.string(), mimeType: z.string(),
  storagePath: z.string().optional(), previewUrl: z.string().optional(), createdAt: isoSchema });
const sessionSchema = z.object({ id: idSchema, userId: idSchema, mode: z.enum(['daily', 'extra', 'weak']),
  questionIds: z.array(idSchema).min(1), createdAt: isoSchema, completedAt: isoSchema.optional(),
  questionSnapshots: z.array(questionSchema).min(1) });
const attemptSchema = z.object({ id: idSchema, userId: idSchema, questionId: idSchema, questionVersion: z.number().int().min(1),
  sessionId: idSchema, selectedIndex: z.number().int().min(0), correct: z.boolean(), answeredAt: isoSchema });
const exposureSchema = z.object({ id: idSchema, userId: idSchema, questionId: idSchema, questionVersion: z.number().int().min(1),
  sessionId: idSchema, shownAt: isoSchema });
const jobSchema = z.object({ id: idSchema, topicId: idSchema, status: z.enum(['queued', 'running', 'review', 'failed']),
  targetCount: z.number().int().min(0), generatedCount: z.number().int().min(0), createdAt: isoSchema, error: z.string().optional() });

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
    case 'generation.batch': z.object({ jobId: idSchema, batch: z.number().int().min(0),
      questions: z.array(questionSchema), job: jobSchema }).parse(payload); break;
    case 'source.analysis': z.object({ sourceId: idSchema, text: z.string().max(100_000) }).parse(payload); break;
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
      case 'topic.created': if (!topics.has(payload.id)) topics.set(payload.id, topicSchema.parse(payload)); break;
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
      case 'generation.batch':
        for (const question of payload.questions) upsertQuestion(questionSchema.parse(question));
        jobs.set(payload.job.id, jobSchema.parse(payload.job));
        break;
      // Analyses and subscriptions remain available only to server callers through the event log.
      case 'source.analysis': case 'push.subscribed': case 'session.completed': break;
    }
  }
  for (const session of sessions.values()) {
    const answers = session.questionIds.map((questionId) => attempts.get(JSON.stringify([session.userId, session.id, questionId])));
    if (answers.every(Boolean)) session.completedAt = answers.map((answer) => answer!.answeredAt)
      .sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
    else delete session.completedAt;
  }
  return { topics: [...topics.values()], sources: [...sources.values()], questions: [...questions.values()],
    attempts: [...attempts.values()], exposures: [...exposures.values()], sessions: [...sessions.values()],
    jobs: [...jobs.values()], profiles: structuredClone(profiles) };
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
  const published = data.questions.filter((question) => question.status === 'published'
    && question.publishedAt && Date.parse(question.publishedAt) <= now.getTime());
  const visibleTopics = new Set(published.map((question) => question.topicId));
  return { ...data, topics: data.topics.filter((topic) => visibleTopics.has(topic.id)), sources: [], jobs: [], profiles: [profile],
    questions: published
      .map((question) => ({ id: question.id, topicId: question.topicId, prompt: question.prompt, choices: [...question.choices],
        correctIndex: -1, explanation: '', learningPoint: '', sourceNote: '', sourceIds: [],
        status: question.status, version: question.version, createdAt: question.createdAt, publishedAt: question.publishedAt })),
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
  sourceId: string; topicId: string; name: string; mimeType: string; size: number;
}): Promise<{ uploadUrl: string; fileId: string }> {
  const config = getDriveConfig();
  if (!SOURCE_MIME_TYPES.includes(input.mimeType as typeof SOURCE_MIME_TYPES[number])
    || !Number.isInteger(input.size) || input.size <= 0 || input.size > MAX_SOURCE_BYTES) {
    throw new ApiError(400, '対応する写真・PDFを10MB以内で選択してください。', 'INVALID_SOURCE');
  }
  if (!input.name.trim() || input.name.length > 200 || input.sourceId.length > 100 || input.topicId.length > 100) {
    throw new ApiError(400, '資料の名前・指定を確認してください。', 'INVALID_SOURCE');
  }
  const idsResponse = await googleFetch('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files');
  const generated = await idsResponse.json() as { ids?: string[] };
  const fileId = generated.ids?.[0];
  if (!fileId) throw new ApiError(502, 'アップロードの準備に失敗しました。', 'UPLOAD_SETUP_FAILED');
  const response = await googleFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': input.mimeType, 'X-Upload-Content-Length': String(input.size) },
    body: JSON.stringify({ id: fileId, name: input.name, mimeType: input.mimeType, parents: [config.folderId],
      appProperties: { purpose: 'hibi-study-source', sourceId: input.sourceId, topicId: input.topicId } }),
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
