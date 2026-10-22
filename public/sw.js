const CACHE = 'hibi-shell-v1';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/offline.html', '/icon.svg'])));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate' && new URL(event.request.url).origin === self.location.origin) {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  }
});
self.addEventListener('push', event => {
  let payload = {title:'新しい問題が届きました',body:'今日のひとつを、できるに。',url:'/'};
  try { if (event.data) payload = {...payload,...event.data.json()}; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title, {
    body:payload.body,icon:'/icon-192.png',badge:'/icon-192.png',tag:'hibi-new-questions',data:{url:payload.url}
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  let target = new URL('/', self.location.origin);
  try { const proposed = new URL(event.notification.data?.url || '/', self.location.origin); if (proposed.origin === self.location.origin) target = proposed; } catch {}
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients => {
    const existing = clients.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { existing.navigate(target.href); return existing.focus(); }
    return self.clients.openWindow(target.href);
  }));
});
