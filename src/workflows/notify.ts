import { sleep, FatalError } from 'workflow';
import { assertExternalEffectAllowed } from '@/server/environment';
import { notifyPublished } from '@/server/push';

async function sendNotification(questionIds:string[]) {
  'use step';
  try { assertExternalEffectAllowed('workflow'); } catch { throw new FatalError('この環境ではバックグラウンド処理を停止しています。'); }
  return notifyPublished(questionIds);
}
// Notifications are best effort; never duplicate pushes automatically after an uncertain send.
sendNotification.maxRetries=0;

export async function publicationNotificationWorkflow(questionIds:string[],publishedAt:string) {
  'use workflow';
  await sleep(new Date(publishedAt));
  await sendNotification(questionIds);
}
