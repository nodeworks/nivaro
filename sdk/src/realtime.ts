// Nivaro realtime client — wraps Socket.io to provide a subscription API.
//
// Usage:
//   cms.realtime.subscribe('workflows', { event: 'update' }, (data) => { ... })

import { io, type Socket } from 'socket.io-client'

export type RealtimeEvent = 'create' | 'update' | 'delete' | '*'

export interface Subscription {
  collection: string
  event?: RealtimeEvent
  callback: (data: unknown[]) => void
}

export interface NivaroRealtime {
  connect(url: string, token?: string): void
  disconnect(): void
  subscribe(
    collection: string,
    opts: { event?: RealtimeEvent; query?: Record<string, unknown> },
    callback: (data: unknown[]) => void
  ): () => void
  onConnect(fn: () => void): void
  onDisconnect(fn: (reason: string) => void): void
  connected: boolean
}

export function createRealtime(): NivaroRealtime {
  let socket: Socket | null = null
  const subs = new Map<string, Subscription>()
  const connectHandlers: Array<() => void> = []
  const disconnectHandlers: Array<(reason: string) => void> = []

  function subscriptionKey(collection: string, event?: RealtimeEvent) {
    return event ? `${collection}:${event}` : `${collection}:*`
  }

  return {
    get connected() {
      return socket?.connected ?? false
    },

    connect(url: string, token?: string) {
      if (socket?.connected) return

      socket = io(url.replace(/\/$/, ''), {
        path: '/socket.io',
        auth: token ? { token } : undefined,
        withCredentials: true,
        transports: ['websocket']
      })

      socket.on('connect', () => {
        for (const fn of connectHandlers) fn()

        // Re-subscribe after reconnect
        for (const sub of subs.values()) {
          socket?.emit('subscribe', {
            collection: sub.collection,
            event: sub.event
          })
        }
      })

      socket.on('disconnect', (reason) => {
        for (const fn of disconnectHandlers) fn(reason)
      })

      // Dispatch incoming item events to subscribers
      socket.on('items:create', ({ collection, data }: { collection: string; data: unknown[] }) => {
        const cb =
          subs.get(subscriptionKey(collection, 'create'))?.callback ??
          subs.get(subscriptionKey(collection))?.callback
        cb?.(data)
      })

      socket.on('items:update', ({ collection, data }: { collection: string; data: unknown[] }) => {
        const cb =
          subs.get(subscriptionKey(collection, 'update'))?.callback ??
          subs.get(subscriptionKey(collection))?.callback
        cb?.(data)
      })

      socket.on('items:delete', ({ collection, ids }: { collection: string; ids: unknown[] }) => {
        const cb =
          subs.get(subscriptionKey(collection, 'delete'))?.callback ??
          subs.get(subscriptionKey(collection))?.callback
        cb?.(ids)
      })

      // Notification events (CMS-level)
      socket.on('notification', (data: unknown) => {
        const cb = subs.get('cms_notifications:*')?.callback
        cb?.([data])
      })
    },

    disconnect() {
      socket?.disconnect()
      socket = null
    },

    subscribe(collection, opts, callback) {
      const key = subscriptionKey(collection, opts.event)
      subs.set(key, { collection, event: opts.event, callback })

      if (socket?.connected) {
        socket.emit('subscribe', { collection, event: opts.event, query: opts.query })
      }

      // Return an unsubscribe function
      return () => {
        subs.delete(key)
        if (socket?.connected) {
          socket.emit('unsubscribe', { collection, event: opts.event })
        }
      }
    },

    onConnect(fn) {
      connectHandlers.push(fn)
    },

    onDisconnect(fn) {
      disconnectHandlers.push(fn)
    }
  }
}
