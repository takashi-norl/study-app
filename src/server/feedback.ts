import 'server-only';
import type { Profile } from '@/lib/types';
import { CURRENT_RELEASE } from '@/lib/releases';
import { ApiError } from './config';
import { feedbackInputSchema } from './feedback-schema';
import type { StudyEvent } from './google-store';

export function prepareFeedback(events: StudyEvent[], profile: Profile, raw: unknown, now = new Date()): StudyEvent | null {
  const input = feedbackInputSchema.parse(raw);
  const id = `feedback:${profile.id}:${input.requestId}`;
  const previous = events.find(event => event.id === id);
  if (previous) {
    if (previous.type !== 'feedback.submitted' || previous.actorId !== profile.id
      || previous.payload.category !== input.category || previous.payload.message !== input.message) {
      throw new ApiError(409, '送信済みの内容と異なります。ページを開き直して送信してください。', 'FEEDBACK_CONFLICT');
    }
    return null;
  }
  const day = (value: string | Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date(value));
  const count = new Set(events.filter(event => event.type === 'feedback.submitted' && event.actorId === profile.id && day(event.createdAt) === day(now)).map(event => event.id)).size;
  if (count >= 5) throw new ApiError(429, '感想は1日5件まで送れます。続きは明日お願いします。', 'FEEDBACK_LIMIT');
  return { id, type: 'feedback.submitted', actorId: profile.id, workspaceId: profile.workspaceId, createdAt: now.toISOString(),
    payload: { userId: profile.id, category: input.category, message: input.message, version: CURRENT_RELEASE.version } };
}
