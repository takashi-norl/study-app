import 'server-only';
import webpush from 'web-push';
import type { PushSubscription } from 'web-push';
import { appendEvent,getFullState } from './google-store';
import { ApiError,requiredEnv } from './config';

export function pushConfigured() {
  return !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
}

export function validatePushEndpoint(endpoint:string) {
  const url=new URL(endpoint);
  const host=url.hostname.toLowerCase();
  const allowed=host==='fcm.googleapis.com' || host==='android.googleapis.com' || host==='updates.push.services.mozilla.com'
    || host.endsWith('.push.services.mozilla.com') || host==='web.push.apple.com' || host.endsWith('.push.apple.com')
    || host.endsWith('.notify.windows.com');
  if(url.protocol!=='https:' || url.port || url.username || url.password || !allowed) throw new ApiError(400,'この通知サービスには対応していません。','INVALID_PUSH_ENDPOINT');
}

export async function notifyPublished(questionIds:string[]) {
  if(!pushConfigured()) return {sent:0,failed:0};
  const {data,events}=await getFullState();
  const available=data.questions.filter(q=>questionIds.includes(q.id) && q.status==='published' && q.publishedAt && Date.parse(q.publishedAt)<=Date.now());
  if(!available.length) return {sent:0,failed:0};
  const subscriptions=new Map<string,PushSubscription>();
  for(const event of events) {
    if(event.type!=='push.subscribed') continue;
    const payload=event.payload as {userId:string;subscription:PushSubscription|null};
    // One subscription per student keeps recovery and revocation simple for the family app.
    if(!data.profiles.some(p=>p.id===payload.userId && p.role==='student')) continue;
    if(payload.subscription) subscriptions.set(payload.userId,payload.subscription);
    else subscriptions.delete(payload.userId);
  }
  webpush.setVapidDetails(requiredEnv('VAPID_SUBJECT'),requiredEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY'),requiredEnv('VAPID_PRIVATE_KEY'));
  let sent=0,failed=0;
  for(const [userId,subscription] of subscriptions) {
    try {
      validatePushEndpoint(subscription.endpoint);
      await webpush.sendNotification(subscription,JSON.stringify({title:'新しい問題が届きました',body:`${available.length}問が追加されました。今日の10問から始めよう。`,url:'/',tag:'hibi-new-questions'}),{TTL:24*60*60,timeout:10000});
      sent++;
    } catch(error) {
      failed++;
      const status=(error as {statusCode?:number})?.statusCode;
      if(status===404 || status===410) await appendEvent({id:`push-expired:${userId}:${Date.now()}`,type:'push.subscribed',actorId:userId,createdAt:new Date().toISOString(),payload:{userId,subscription:null}});
    }
  }
  return {sent,failed};
}
