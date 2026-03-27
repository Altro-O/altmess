self.addEventListener('push', (event) => {
  if (!event.data) {
    return;
  }

  const payload = event.data.json();
  const title = payload.title || 'Altmess';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'altmess-notification',
    icon: '/altmess.jpeg',
    badge: '/altmess.jpeg',
    data: {
      ...(payload.data || {}),
      url: payload.url || '/dashboard/chat',
    },
    requireInteraction: Boolean(payload.requireInteraction),
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/dashboard/chat';

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const matchingClient = clientsList.find((client) => 'focus' in client);

    if (matchingClient) {
      await matchingClient.focus();
      if ('navigate' in matchingClient) {
        await matchingClient.navigate(targetUrl);
      }
      return;
    }

    await self.clients.openWindow(targetUrl);
  })());
});
