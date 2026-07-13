/* Nivaro service worker — web push display + click-through. */

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Nivaro', body: event.data ? event.data.text() : '' }
  }
  const title = data.title || 'Nivaro'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url: data.url || '/notifications' }
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/notifications'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if ('focus' in win) {
          win.focus()
          if ('navigate' in win) win.navigate(url)
          return
        }
      }
      return clients.openWindow(url)
    })
  )
})
