/**
 * Socket events in session replay (#2476): the realtime events the page received and its
 * connection changes ride the recording as `socket` rrweb custom events, so "the screen changed
 * by itself" points at the event that did it.
 *
 * Privacy: realtime payloads are ids and field NAMES only already; this keeps the event name,
 * the room, up to MAX_IDS ids and up to MAX_FIELDS field names — never any other value. The
 * track has its own cap per recording (SOCKET_MAX_EVENTS), separate from console and requests.
 *
 * Hosts feed the bus: `tapReplaySocket(socket)` attaches to any socket.io-style client, or call
 * `reportSocketEvent` / `reportSocketConnection` directly. `instrumentSocket(emit)` (the
 * recorders) subscribes to the bus for the life of a recording.
 */
import { redactSecrets } from './replay-context'

export const SOCKET_MAX_EVENTS = 800
export const SOCKET_MAX_IDS = 10
export const SOCKET_MAX_FIELDS = 20

export type SocketConnectionState =
  | 'connected'
  | 'reconnected'
  | 'disconnected'
  | 'error'
  | 'catch-up'
  | 'full-resync'

export interface SocketTrackEvent {
  kind: 'event' | 'connection' | 'truncated'
  /** Event name (kind event) or connection state (kind connection). */
  name: string
  room?: string
  ids?: string[]
  /** How many ids the payload carried, when more than listed. */
  n?: number
  fields?: string[]
  /** Connection detail, e.g. the disconnect reason. */
  detail?: string
}

type Emit = (tag: string, payload: unknown) => void

/** Chatter that says nothing about why the screen changed. */
const NOISE = new Set([
  'nvr:ping',
  'nvr:pong',
  'time:sync',
  'chat:typing',
  'presence:update',
  'catchup:cursor'
])

const listeners = new Set<(e: SocketTrackEvent) => void>()

const short = (v: unknown, max: number): string =>
  redactSecrets(String(v)).replace(/\s+/g, ' ').slice(0, max)

function scalarIds(v: unknown): string[] {
  const list = Array.isArray(v) ? v : v == null ? [] : [v]
  const out: string[] = []
  for (const x of list) {
    if (typeof x === 'string' || typeof x === 'number') out.push(short(x, 64))
  }
  return out
}

/** The ids / room / field names of one realtime payload — never any other value. */
export function describeSocketPayload(
  payload: unknown
): Pick<SocketTrackEvent, 'room' | 'ids' | 'n' | 'fields'> {
  const out: Pick<SocketTrackEvent, 'room' | 'ids' | 'n' | 'fields'> = {}
  const p = (Array.isArray(payload) ? payload[0] : payload) as Record<string, unknown> | null
  if (!p || typeof p !== 'object') return out
  const room = [p.room, p.collection, p.topic].find((x) => typeof x === 'string' && x)
  if (room) out.room = short(room, 80)
  const ids = scalarIds(p.ids ?? p.keys ?? p.id ?? p.item ?? p.item_id)
  if (ids.length) {
    out.ids = ids.slice(0, SOCKET_MAX_IDS)
    if (ids.length > SOCKET_MAX_IDS) out.n = ids.length
  }
  const fields = p.fields ?? p.field_names ?? p.changed
  if (Array.isArray(fields)) {
    const names = fields
      .filter((x): x is string => typeof x === 'string')
      .map((x) => short(x, 48))
      .slice(0, SOCKET_MAX_FIELDS)
    if (names.length) out.fields = names
  }
  return out
}

/** A socket event arrived. No-op when no recording listens. */
export function reportSocketEvent(name: string, payload?: unknown): void {
  if (listeners.size === 0 || !name || NOISE.has(name)) return
  try {
    const e: SocketTrackEvent = {
      kind: 'event',
      name: short(name, 80),
      ...describeSocketPayload(payload)
    }
    for (const l of listeners) l(e)
  } catch {
    /* never break the socket */
  }
}

/** The connection changed (reconnect, catch-up, full resync…). */
export function reportSocketConnection(state: SocketConnectionState, detail?: string): void {
  if (listeners.size === 0) return
  try {
    const e: SocketTrackEvent = { kind: 'connection', name: state }
    if (detail) e.detail = short(detail, 80)
    for (const l of listeners) l(e)
  } catch {
    /* never break the socket */
  }
}

interface SocketLike {
  on(ev: string, fn: (...a: any[]) => void): unknown
  onAny?(fn: (ev: string, ...a: any[]) => void): unknown
  offAny?(fn: (ev: string, ...a: any[]) => void): unknown
  off?(ev: string, fn: (...a: any[]) => void): unknown
  io?: { on?(ev: string, fn: (...a: any[]) => void): unknown }
}

/** Feed the bus from a socket.io-style client. Returns the undo. */
export function tapReplaySocket(socket: SocketLike): () => void {
  let connects = 0
  const any = (ev: string, ...a: unknown[]) => {
    if (ev === 'catchup:full') reportSocketConnection('full-resync')
    else if (ev === 'catchup:events') {
      const n = (a[0] as { events?: unknown[] } | undefined)?.events?.length ?? 0
      reportSocketConnection('catch-up', `${n} missed event${n === 1 ? '' : 's'} replayed`)
    } else reportSocketEvent(ev, a[0])
  }
  const onConnect = () => reportSocketConnection(connects++ > 0 ? 'reconnected' : 'connected')
  const onDisconnect = (reason?: string) => reportSocketConnection('disconnected', reason)
  const onError = (err?: { message?: string }) => reportSocketConnection('error', err?.message)
  socket.onAny?.(any)
  socket.on('connect', onConnect)
  socket.on('disconnect', onDisconnect)
  socket.on('connect_error', onError)
  return () => {
    socket.offAny?.(any)
    socket.off?.('connect', onConnect)
    socket.off?.('disconnect', onDisconnect)
    socket.off?.('connect_error', onError)
  }
}

/**
 * Subscribe a recording: every reported socket event becomes a `socket` custom event, up to
 * `max` (then one `truncated` marker, nothing more). Returns the undo.
 */
export function instrumentSocket(emit: Emit, max = SOCKET_MAX_EVENTS): () => void {
  let sent = 0
  let off = false
  const l = (e: SocketTrackEvent) => {
    if (off || sent > max) return
    try {
      if (sent === max) {
        sent++
        emit('socket', { kind: 'truncated', name: 'cap reached' } satisfies SocketTrackEvent)
        return
      }
      sent++
      emit('socket', e)
    } catch {
      /* best-effort */
    }
  }
  listeners.add(l)
  return () => {
    off = true
    listeners.delete(l)
  }
}
