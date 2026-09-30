/* Nivaro service worker — web push display + click-through. */

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Nivaro', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(show(data))
})

async function show(data) {
  const title = data.title || 'Nivaro'
  const url = data.url || (data.room ? `/chat?room=${encodeURIComponent(data.room)}` : '/notifications')
  if (!data.room) {
    return self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url }
    })
  }
  // Chat (#967): one notification per room. A second message replaces the
  // first and says how many are waiting, instead of stacking a pile.
  const tag = data.tag || `chat-${data.room}`
  const open = await self.registration.getNotifications({ tag })
  const prev = open[0] && open[0].data ? open[0].data.count || 1 : 0
  const count = prev + 1
  for (const n of open) n.close()
  const body = count > 1 ? `${count} new messages · ${data.body || ''}` : data.body || ''
  const options = {
    body,
    tag,
    renotify: true,
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    data: { url, room: data.room, count, reply_token: data.reply_token || null }
  }
  // Reply from the notification (#956) where the browser offers a text action.
  if (data.reply_token) {
    options.actions = [
      { action: 'reply', type: 'text', title: 'Reply', placeholder: 'Write a reply…' }
    ]
  }
  return self.registration.showNotification(title, options)
}

self.addEventListener('notificationclick', (event) => {
  const d = event.notification.data || {}
  if (event.action === 'reply' && d.reply_token) {
    const text = (event.reply || '').trim()
    event.notification.close()
    if (!text) return
    event.waitUntil(
      fetch('/api/chat-push/push-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: d.reply_token, message: text })
      })
        .then((res) =>
          res.ok
            ? undefined
            : self.registration.showNotification('Reply not sent', {
                body: 'Open the conversation to send it.',
                tag: `chat-${d.room}-failed`,
                icon: '/favicon.svg',
                data: { url: d.url }
              })
        )
        .catch(() => undefined)
    )
    return
  }
  event.notification.close()
  const raw = d.url || '/notifications'
  const url = new URL(raw, self.location.origin)
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // A link into another app (a headless frontend) opens a new tab; only
      // this app's own pages reuse an open tab.
      if (url.origin === self.location.origin) {
        for (const win of wins) {
          if ('focus' in win) {
            win.focus()
            if ('navigate' in win) return win.navigate(url.href)
            return
          }
        }
      }
      return clients.openWindow(url.href)
    })
  )
})
