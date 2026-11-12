/* Nivaro service worker — web push display + click-through. Push only: no
   fetch handler, so it never caches or intercepts app requests, and a new
   version can take over at once. */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// Raster icons from scripts/push-icons.mjs: Chrome draws no SVG in a notification.
const BADGE = '/push/badge.png'
const iconFor = (key) =>
  `/push/${/^[a-z]+(-needs|-critical)?$/.test(key || '') ? key : 'default'}.png`

/** Mark the inbox row read, as the signed-in person (session cookie). */
function markRead(id) {
  if (id == null) return Promise.resolve()
  return fetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  }).catch(() => undefined)
}

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
  const url =
    data.url || (data.room ? `/chat?room=${encodeURIComponent(data.room)}` : '/notifications')
  if (!data.room) {
    const at = data.at ? Date.parse(data.at) : Number.NaN
    const options = {
      body: data.body || '',
      icon: iconFor(data.icon),
      badge: BADGE,
      // FYI arrives without a sound; critical stays until it is dealt with.
      silent: data.lane === 'fyi',
      requireInteraction: data.lane === 'critical',
      data: { url, id: data.id ?? null, stop_token: data.stop_token || null }
    }
    if (Number.isFinite(at)) options.timestamp = at
    // A newer push about the same record replaces the older one (and still sounds).
    if (data.tag) {
      options.tag = data.tag
      options.renotify = true
    }
    if (data.stop_token) {
      // Chaos drills (#2861): Stop ends every fault on the instance, no sign-in needed.
      options.actions = [{ action: 'chaos-stop', title: 'Stop all faults' }]
      options.requireInteraction = true
    } else if (data.id != null) {
      options.actions = [
        { action: 'open', title: 'Open' },
        { action: 'read', title: 'Mark as read' }
      ]
    }
    return self.registration.showNotification(title, options)
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
    icon: iconFor(data.icon || 'chat'),
    badge: BADGE,
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
  if (event.action === 'chaos-stop' && d.stop_token) {
    event.notification.close()
    event.waitUntil(
      fetch('/api/chaos/stop-all/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: d.stop_token })
      })
        .then((res) =>
          res.json().then(
            (b) => ({ ok: res.ok, b }),
            () => ({ ok: res.ok, b: {} })
          )
        )
        .then(({ ok, b }) =>
          self.registration.showNotification(ok ? 'Faults stopped' : 'Stop did not go through', {
            body: ok
              ? `${(b.data && b.data.stopped && b.data.stopped.length) || 0} fault(s) stopped on this instance.`
              : (b && b.error) || 'Open the chaos console to stop them.',
            tag: 'chaos-stop-result',
            icon: iconFor('chaos'),
            badge: BADGE,
            data: { url: '/chaos' }
          })
        )
        .catch(() =>
          self.registration.showNotification('Stop did not go through', {
            body: 'Open the chaos console to stop them.',
            tag: 'chaos-stop-result',
            icon: iconFor('chaos'),
            badge: BADGE,
            data: { url: '/chaos' }
          })
        )
    )
    return
  }
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
                icon: iconFor('chat'),
                badge: BADGE,
                data: { url: d.url }
              })
        )
        .catch(() => undefined)
    )
    return
  }
  if (event.action === 'read') {
    event.notification.close()
    event.waitUntil(markRead(d.id))
    return
  }
  // A click (or Open) goes to the target and counts as reading it.
  event.notification.close()
  const read = markRead(d.id)
  const raw = d.url || '/notifications'
  const url = new URL(raw, self.location.origin)
  event.waitUntil(
    Promise.all([
      read,
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
    ])
  )
})
