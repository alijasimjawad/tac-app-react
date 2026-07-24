self.addEventListener('push', function(event) {
  if (!event.data) return;
  const data = event.data.json();
  const options = {
    body: data.body,
    icon: '/tac-logo-192.png',
    badge: '/tac-logo-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    actions: [{ action: 'open', title: 'Open App' }]
  };
  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || '/'));
});
