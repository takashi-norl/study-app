export type EncouragementStyle = 'gentle' | 'direct' | 'energetic';

export interface PersonalPreferences {
  nickname: string;
  schoolYear: string;
  goals: string;
  interests: string;
  encouragementStyle: EncouragementStyle;
  dailyMinutes: number;
  enabled: boolean;
  personalizedMessages: string[];
}

export interface PersonalProfile extends PersonalPreferences {
  ownerId: string;
  version: number;
  updatedAt: string;
}

export interface PersonalProfileTurn {
  id: string;
  version: number;
  status: 'pending' | 'complete' | 'failed';
  message: string;
  createdAt: string;
  completedAt?: string;
  reply?: string;
  draft?: PersonalPreferences;
  error?: string;
}

export interface PersonalProfileState {
  profile: PersonalProfile | null;
  version: number;
  turns: PersonalProfileTurn[];
  aiEnabled: boolean;
}

export function defaultPersonalPreferences(): PersonalPreferences {
  return {nickname: '', schoolYear: '', goals: '', interests: '', encouragementStyle: 'gentle', dailyMinutes: 10, enabled: false, personalizedMessages: []};
}

/** Match the server's normalization while excluding persistence metadata. */
export function normalizePersonalPreferences(value: PersonalPreferences): PersonalPreferences {
  return {
    nickname: value.nickname.trim(), schoolYear: value.schoolYear.trim(),
    goals: value.goals.trim(), interests: value.interests.trim(),
    encouragementStyle: value.encouragementStyle, dailyMinutes: value.dailyMinutes,
    enabled: value.enabled,
    personalizedMessages: value.personalizedMessages.map(message => message.trim()).filter(Boolean),
  };
}

export function personalProfileSaveState(draft: PersonalPreferences, persisted: PersonalPreferences | null, saving = false) {
  if (saving) return { status: 'saving' as const, label: '保存しています', disabled: true };
  if (!persisted) return { status: 'new' as const, label: 'プロフィールを保存する', disabled: false };
  const current = normalizePersonalPreferences(draft);
  const saved = normalizePersonalPreferences(persisted);
  const matches = current.dailyMinutes === saved.dailyMinutes && JSON.stringify(current) === JSON.stringify(saved);
  return matches
    ? { status: 'saved' as const, label: '保存済み', disabled: true }
    : { status: 'changed' as const, label: '変更を保存', disabled: false };
}

/** Reading a saved message never makes an AI request. Progress takes precedence over encouragement. */
export function personalizedStudyMessage(profile: PersonalProfile | null | undefined, options: {
  fallback?: string; date?: Date; todayAnswers?: number; dailyTarget?: number;
} = {}): string {
  const fallback = options.fallback ?? '今日の10問が、明日の自信に。';
  if (!profile?.enabled) return fallback;
  if ((options.todayAnswers ?? 0) >= (options.dailyTarget ?? 10)) {
    return profile.encouragementStyle === 'energetic'
      ? '今日の目安、達成！ ここでひと息。続きは明日でも大丈夫。'
      : '今日の目安は達成しました。ひと息ついて、また自分のペースで。';
  }
  const day = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Tokyo'}).format(options.date ?? new Date());
  if (profile.personalizedMessages.length) {
    const hash = [...`${profile.ownerId}:${day}`].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
    return profile.personalizedMessages[hash % profile.personalizedMessages.length];
  }
  const name = profile.nickname ? `${profile.nickname}さん、` : '';
  if (profile.encouragementStyle === 'direct') return `${name}今日は${profile.dailyMinutes}分を目安に。まず1問、理解を確かめよう。`;
  if (profile.encouragementStyle === 'energetic') return `${name}まず1問から始めよう！ ${profile.dailyMinutes}分を目安に、できる分だけ。`;
  return `${name}今日は${profile.dailyMinutes}分を目安に、できるところから少しずつ。`;
}
