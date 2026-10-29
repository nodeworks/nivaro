// Nivaro realtime client — wraps Socket.io to provide a subscription API.
//
// Usage:
//   const rt = createRealtime()
//   rt.connect('https://cms.example.com', token)          // static token / View-as token
//   rt.connect(url, () => client.request(readWsToken()).then((r) => r.token))  // API key / cookie
//   rt.subscribe('workflows', { event: 'update' }, (changes) => { ... })
//
// Wire protocol (api/src/plugins/socketio.ts, services/realtime.ts):
//   - sign-in: the client emits `auth {token}` after connecting; the server answers `auth:ok`.
//     It takes a one-time ws-token (GET /api/auth/ws-token, which works for every sign-in:
//     session cookie, API key, static token), a View-as token, or a user's static token.
//     Named API keys sign a socket in only through a ws-token.
//   - rooms: `collection:join {collection}` / `collection:leave {collection}` (read-gated).
//   - record events: `collection:update` with ids, the action and changed field NAMES only —
//     never values (read the record through the REST API). Bursts arrive coalesced:
//     `{ items: [...ids], many, count, coalesced: true }`.
//   - notifications: `notification:new` in the signed-in person's own room.

import { io, type Socket } from 'socket.io-client'

export type RealtimeEvent = 'create' | 'update' | 'delete' | '*'

/** One record change as the server announced it. Values never ride the socket. */
export interface RealtimeChange {
  collection: string
  /** The record id; null when a coalesced burst was too large to list (`many`). */
  item: string | number | null
  action: 'create' | 'update' | 'delete'
  /** Changed field names (updates), when the server knew them. */
  changed_fields?: string[]
  /** `import` when a staged import run made the write. */
  source?: string
  /** Part of a coalesced burst (several writes folded into one message). */
  coalesced?: boolean
  /** A burst too large to list ids: refetch the list instead. */
  many?: boolean
}

export interface Subscription {
  collection: string
  event?: RealtimeEvent
  /** Called with the changes of one message (`RealtimeChange[]`; notifications: `[notification]`). */
  callback: (data: unknown[]) => void
}

/** A token, or a function asked on every (re)connect — ws-tokens are single-use. */
export type RealtimeToken =
  | string
  | (() => string | null | undefined | Promise<string | null | undefined>)

export interface NivaroRealtime {
  connect(url: string, token?: RealtimeToken): void
  disconnect(): void
  subscribe(
    collection: string,
    opts: { event?: RealtimeEvent; query?: Record<string, unknown> },
    callback: (data: unknown[]) => void
  ): () => void
  onConnect(fn: () => void): void
  onDisconnect(fn: (reason: string) => void): void
  /** Called when the server accepted the sign-in (`auth:ok`); rooms are joined then. */
  onAuthenticated(fn: (userId: string) => void): void
  connected: boolean
  /** True between `auth:ok` and the next disconnect. */
  authenticated: boolean
}

/** Pseudo-collection: subscribe to it to hear `notification:new` for the signed-in person. */
export const NOTIFICATIONS_CHANNEL = 'cms_notifications'

type UpdatePayload = {
  collection?: string
  item?: string | number | null
  items?: Array<string | number> | null
  many?: boolean
  action?: string
  changed_fields?: string[]
  source?: string
  coalesced?: boolean
}

/** The changes one `collection:update` message names. Exported for tests. */
export function parseRealtimeChanges(payload: UpdatePayload): RealtimeChange[] {
  const collection = String(payload?.collection ?? '')
  if (!collection) return []
  const action = (
    payload.action === 'create' || payload.action === 'delete' ? payload.action : 'update'
  ) as RealtimeChange['action']
  const base: Omit<RealtimeChange, 'item'> = {
    collection,
    action,
    ...(payload.changed_fields?.length ? { changed_fields: payload.changed_fields } : {}),
    ...(payload.source ? { source: payload.source } : {})
  }
  if (payload.coalesced || payload.items || payload.many) {
    if (payload.many || !payload.items)
      return [{ ...base, item: null, coalesced: true, many: true }]
    return payload.items.map((item) => ({ ...base, item, coalesced: true }))
  }
  return [{ ...base, item: payload.item ?? null }]
}

export function createRealtime(): NivaroRealtime {
  let socket: Socket | null = null
  let signedIn = false
  const subs = new Map<string, Subscription>()
  const connectHandlers: Array<() => void> = []
  const disconnectHandlers: Array<(reason: string) => void> = []
  const authHandlers: Array<(userId: string) => void> = []

  function subscriptionKey(collection: string, event?: RealtimeEvent) {
    return event && event !== '*' ? `${collection}:${event}` : `${collection}:*`
  }

  /** Collections with at least one subscription (notifications are not a room). */
  function subscribedCollections(): string[] {
    const out = new Set<string>()
    for (const s of subs.values()) if (s.collection !== NOTIFICATIONS_CHANNEL) out.add(s.collection)
    return [...out]
  }

  function dispatch(change: RealtimeChange[], collection: string, action: RealtimeEvent) {
    if (change.length === 0) return
    const specific = subs.get(subscriptionKey(collection, action))?.callback
    const any = subs.get(subscriptionKey(collection))?.callback
    // Both may listen: the specific one and a '*' one each hear the message once.
    specific?.(change)
    if (any && any !== specific) any(change)
  }

  return {
    get connected() {
      return socket?.connected ?? false
    },

    get authenticated() {
      return signedIn
    },

    connect(url: string, token?: RealtimeToken) {
      if (socket?.connected) return

      socket = io(url.replace(/\/$/, ''), {
        path: '/socket.io',
        withCredentials: true,
        // Websocket first; when a proxy blocks the upgrade, long-polling on the same attempt.
        transports: ['websocket', 'polling'],
        tryAllTransports: true
      })
      const s = socket

      s.on('connect', () => {
        signedIn = false
        for (const fn of connectHandlers) fn()
        // Sign in on every (re)connect: a ws-token is single-use, so a getter is asked again.
        void (async () => {
          try {
            const t = typeof token === 'function' ? await token() : token
            if (t && s.connected) s.emit('auth', { token: t })
          } catch {
            /* no token this time: the socket stays signed out (rooms refuse it) */
          }
        })()
      })

      s.on('auth:ok', (payload: { userId?: string }) => {
        signedIn = true
        // Rooms are read-gated: join them only once the server knows who this is.
        for (const collection of subscribedCollections()) s.emit('collection:join', { collection })
        for (const fn of authHandlers) fn(String(payload?.userId ?? ''))
      })

      s.on('disconnect', (reason) => {
        signedIn = false
        for (const fn of disconnectHandlers) fn(reason)
      })

      s.on('collection:update', (payload: UpdatePayload) => {
        const changes = parseRealtimeChanges(payload)
        if (changes.length === 0) return
        const collection = changes[0].collection
        // One message can mix actions only when coalesced without one; split per action.
        const byAction = new Map<RealtimeChange['action'], RealtimeChange[]>()
        for (const c of changes) byAction.set(c.action, [...(byAction.get(c.action) ?? []), c])
        for (const [action, list] of byAction) dispatch(list, collection, action)
      })

      s.on('notification:new', (data: unknown) => {
        subs.get(`${NOTIFICATIONS_CHANNEL}:*`)?.callback([data])
      })
    },

    disconnect() {
      socket?.disconnect()
      socket = null
      signedIn = false
    },

    subscribe(collection, opts, callback) {
      const key = subscriptionKey(collection, opts.event)
      const already = subscribedCollections().includes(collection)
      subs.set(key, { collection, event: opts.event, callback })

      if (socket?.connected && signedIn && !already && collection !== NOTIFICATIONS_CHANNEL) {
        socket.emit('collection:join', { collection })
      }

      // Return an unsubscribe function
      return () => {
        if (subs.get(key)?.callback !== callback) return
        subs.delete(key)
        const still = subscribedCollections().includes(collection)
        if (socket?.connected && !still && collection !== NOTIFICATIONS_CHANNEL) {
          socket.emit('collection:leave', { collection })
        }
      }
    },

    onConnect(fn) {
      connectHandlers.push(fn)
    },

    onDisconnect(fn) {
      disconnectHandlers.push(fn)
    },

    onAuthenticated(fn) {
      authHandlers.push(fn)
    }
  }
}
