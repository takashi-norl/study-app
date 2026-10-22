import { sleep } from 'workflow';
import { notifyPublished } from '@/server/push';

async function sendNotification(questionIds:string[]) {
  'use step';
  return notifyPublished(questionIds);
}
// Notifications are best effort; never duplicate pushes automatically after an uncertain send.
sendNotification.maxRetries=0;

export async function publicationNotificationWorkflow(questionIds:string[],publishedAt:string) {
  'use workflow';
  await sleep(new Date(publishedAt));
  await sendNotification(questionIds);
}
