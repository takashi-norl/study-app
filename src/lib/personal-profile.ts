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
