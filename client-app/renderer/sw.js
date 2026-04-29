/* ListaPranzo — Service Worker (Push Notifications) */
'use strict';

self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); }
  catch (_) { payload = { title: 'ListaPranzo', body: event.data.text() }; }

  const title   = payload.title || 'ListaPranzo';
  const options = {
    body:  payload.body  || '',
    icon:  '/client/icon-192.png',   // optional: add a PNG icon to the renderer folder
    badge: '/client/icon-72.png',
    tag:   payload.type  || 'listapranzo',  // replaces previous notification of same type
    renotify: true,
    data: { url: self.registration.scope }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/client/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus an existing tab if one is open
      for (const client of list) {
        if (client.url.startsWith(target) && 'focus' in client) return client.focus();
      }
      // Otherwise open a new tab
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
