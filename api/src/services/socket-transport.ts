/**
 * Socket transport bookkeeping (#1730 payload size, #1681 burst coalescing, #1732 per tenant).
 *
 * Everything here is in-process and per API node, like the rest of the Realtime console:
 * - bytes and event counts per event type and per room KIND (`record:workflows:*`, not one
 *   row per record — a table with one entry per room would grow without bound);
 * - a per-socket coalescer for `collection:update`: the first event for a collection goes out
 *   at once, the rest of a one-second window collapse into ONE message listing the ids;
 * - per-tenant socket counts, event rates and bytes for the cloud operator view.
 *
 * Byte figures are the encoded payload BEFORE per-message compression — what the server had
 * to produce, which is what a heavy broadcast costs whether or not deflate shrinks it.
 */

export interface CountBytes {
  count: number
  bytes: number
}

const MAX_KEYS = 500

/**
 * Counters for one scope. Self-hosted there is one scope (''); in cloud mode each tenant has
 * its own, so a tenant's Realtime console never names another tenant's collections or rooms.
 */
interface Scope {
  since: number
  events: number
  bytes: number
  bursts: number
  saved: number
  byEvent: Map<string, CountBytes>
  byRoom: Map<string, CountBytes>
}
const scopes = new Map<string, Scope>()

function scopeOf(tenant: string | null | undefined): Scope {
  const key = tenant ?? ''
  let s = scopes.get(key)
  if (!s) {
    s = {
      since: Date.now(),
      events: 0,
      bytes: 0,
      bursts: 0,
      saved: 0,
      byEvent: new Map(),
      byRoom: new Map()
    }
    scopes.set(key, s)
  }
  return s
}

/**
 * A room name without its cloud tenant prefix (tenant-rooms.ts, `t:<tenant>:<room>`), and the
 * tenant it named ('' = none — self-hosted rooms carry no prefix).
 */
export function splitTenantRoom(room: string): { tenant: string; room: string } {
  const m = /^t:([^:]+):(.+)$/.exec(room)
  return m ? { tenant: m[1], room: m[2] } : { tenant: '', room }
}

/** Rooms that name a sign-in (session ids, masquerade hashes) — never listed anywhere (H2). */
export function isCredentialRoom(room: string): boolean {
  const r = splitTenantRoom(room).room
  return r.startsWith('session:') || r.startsWith('masq:')
}

/**
 * The Realtime console's socket and room lists as a caller may see them (H2). In cloud mode
 * one process holds several tenants' sockets, so `tenant` keeps only that tenant's sockets and
 * the rooms counted from them, tenant prefix taken off. Self-hosted (`tenant` null): all.
 * Sign-in rooms are dropped either way.
 */
export function scopeRealtimeStats<
  S extends { tenant?: string | null; rooms: string[] },
  R extends { room: string; size: number }
>(
  stats: { sockets: S[]; rooms: R[] },
  tenant: string | null
): { sockets: S[]; rooms: Array<{ room: string; size: number }> } {
  if (tenant == null)
    return {
      sockets: stats.sockets.map((s) => ({
        ...s,
        rooms: s.rooms.filter((r) => !isCredentialRoom(r))
      })),
      rooms: stats.rooms.filter((r) => !isCredentialRoom(r.room))
    }
  const sockets = stats.sockets
    .filter((s) => s.tenant === tenant)
    .map((s) => ({
      ...s,
      rooms: s.rooms.filter((r) => !isCredentialRoom(r)).map((r) => splitTenantRoom(r).room)
    }))
  const counts = new Map<string, number>()
  for (const s of sockets) for (const r of s.rooms) counts.set(r, (counts.get(r) ?? 0) + 1)
  const rooms = [...counts.entries()]
    .map(([room, size]) => ({ room, size }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 100)
  return { sockets, rooms }
}

/** A room's kind: ids folded away so the table stays small and readable. */
export function roomKind(room: string | null | undefined): string {
  if (!room) return 'direct'
  // Counters are already kept per tenant; the prefix would only split one kind into many.
  room = splitTenantRoom(room).room
  if (room.startsWith('user:')) return 'user:*'
  if (room.startsWith('session:')) return 'session:*'
  if (room.startsWith('masq:')) return 'masq:*'
  if (room.startsWith('replay:')) return 'replay:*'
  if (room.startsWith('presence:')) return 'presence:*'
  if (room.startsWith('tenant:')) return 'tenant:*'
  if (room.startsWith('record:')) {
    const parts = room.split(':')
    return parts.length >= 3 ? `record:${parts[1]}:*` : room
  }
  if (room.startsWith('chat:')) {
    const rest = room.slice(5)
    if (rest.startsWith('dm:')) return 'chat:dm:*'
    if (rest === 'global') return 'chat:global'
    const kind = rest.split(':')[0]
    return `chat:${kind}:*`
  }
  return room
}

function bump(map: Map<string, CountBytes>, key: string, bytes: number): void {
  let row = map.get(key)
  if (!row) {
    if (map.size >= MAX_KEYS) key = 'other'
    row = map.get(key) ?? { count: 0, bytes: 0 }
    map.set(key, row)
  }
  row.count++
  row.bytes += bytes
}

// ── Per tenant (#1732) ──────────────────────────────────────────────────────

interface TenantRow {
  tenant: string
  label: string | null
  sockets: number
  events: number
  bytes: number
  /** Epoch minute → [events, bytes]; only the current and previous minute are kept. */
  minutes: Map<number, [number, number]>
}
const byTenant = new Map<string, TenantRow>()

function tenantRow(tenant: string, label?: string | null): TenantRow {
  let row = byTenant.get(tenant)
  if (!row) {
    row = { tenant, label: label ?? null, sockets: 0, events: 0, bytes: 0, minutes: new Map() }
    byTenant.set(tenant, row)
  } else if (label && !row.label) row.label = label
  return row
}

/** A socket of `tenant` connected (+1) or went away (-1). */
export function noteTenantSocket(tenant: string, delta: 1 | -1, label?: string | null): void {
  const row = tenantRow(tenant, label)
  row.sockets = Math.max(0, row.sockets + delta)
}

/** One outbound packet written to one socket. */
export function recordOutbound(
  event: string,
  room: string | null,
  bytes: number,
  tenant: string | null
): void {
  const scope = scopeOf(tenant)
  scope.events++
  scope.bytes += bytes
  bump(scope.byEvent, event, bytes)
  bump(scope.byRoom, roomKind(room), bytes)
  if (tenant) {
    const row = tenantRow(tenant)
    row.events++
    row.bytes += bytes
    const minute = Math.floor(Date.now() / 60_000)
    const m = row.minutes.get(minute) ?? [0, 0]
    m[0]++
    m[1] += bytes
    row.minutes.set(minute, m)
    if (row.minutes.size > 2)
      for (const k of row.minutes.keys()) if (k < minute - 1) row.minutes.delete(k)
  }
}

export function noteCoalesced(collapsed: number, tenant: string | null = null): void {
  const scope = scopeOf(tenant)
  scope.bursts++
  scope.saved += Math.max(0, collapsed - 1)
}

export interface TransportStats {
  since: string
  events: number
  bytes: number
  coalesced: { bursts: number; messages_saved: number }
  by_event: Array<{ event: string; count: number; bytes: number }>
  by_room: Array<{ room: string; count: number; bytes: number }>
}

function top(map: Map<string, CountBytes>, limit: number) {
  return [...map.entries()]
    .map(([k, v]) => ({ key: k, count: v.count, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count)
    .slice(0, limit)
}

/** One scope's figures (the caller's tenant in cloud mode; the one scope self-hosted). */
export function transportStats(limit = 15, tenant: string | null = null): TransportStats {
  const s = scopeOf(tenant)
  return {
    since: new Date(s.since).toISOString(),
    events: s.events,
    bytes: s.bytes,
    coalesced: { bursts: s.bursts, messages_saved: s.saved },
    by_event: top(s.byEvent, limit).map((r) => ({ event: r.key, count: r.count, bytes: r.bytes })),
    by_room: top(s.byRoom, limit).map((r) => ({ room: r.key, count: r.count, bytes: r.bytes }))
  }
}

export function resetTransportStats(tenant: string | null = null): void {
  scopes.delete(tenant ?? '')
}

export interface TenantRealtimeRow {
  tenant: string
  label: string | null
  sockets: number
  events: number
  bytes: number
  events_last_minute: number
  bytes_last_minute: number
}

/** Noisiest tenants first: last minute's bytes, then events, then sockets. */
export function tenantRealtimeRanking(now = Date.now()): TenantRealtimeRow[] {
  const minute = Math.floor(now / 60_000)
  return [...byTenant.values()]
    .map((r) => {
      // The previous whole minute is the honest rate; the current one is still filling.
      const prev = r.minutes.get(minute - 1) ?? [0, 0]
      const cur = r.minutes.get(minute) ?? [0, 0]
      const pick = prev[0] >= cur[0] ? prev : cur
      return {
        tenant: r.tenant,
        label: r.label,
        sockets: r.sockets,
        events: r.events,
        bytes: r.bytes,
        events_last_minute: pick[0],
        bytes_last_minute: pick[1]
      }
    })
    .sort(
      (a, b) =>
        b.bytes_last_minute - a.bytes_last_minute ||
        b.events_last_minute - a.events_last_minute ||
        b.sockets - a.sockets
    )
}

export function resetTenantRealtime(): void {
  byTenant.clear()
}

// ── Packet helpers ─────────────────────────────────────────────────────────

/**
 * The event name of an encoded socket.io EVENT packet for the default namespace
 * (`2["name",…]`, or `2<ackId>["name",…]`). Null for anything else (binary, other
 * namespaces, acks) — those are counted under their packet type.
 */
export function eventNameOf(encoded: string): string | null {
  if (encoded.charCodeAt(0) !== 50 /* '2' */) return null
  let i = 1
  while (i < encoded.length && encoded.charCodeAt(i) >= 48 && encoded.charCodeAt(i) <= 57) i++
  if (encoded[i] !== '[' || encoded[i + 1] !== '"') return null
  const end = encoded.indexOf('"', i + 2)
  return end > 0 ? encoded.slice(i + 2, end) : null
}

/** Payload of a plain `2["collection:update",{…}]` packet, or null. */
export function collectionUpdateOf(encoded: string): Record<string, unknown> | null {
  if (!encoded.startsWith('2["collection:update",')) return null
  try {
    const parsed = JSON.parse(encoded.slice(1)) as unknown[]
    const p = parsed[1]
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function encodeEvent(event: string, payload: unknown): string {
  return `2${JSON.stringify([event, payload])}`
}

// ── Coalescing (#1681) ──────────────────────────────────────────────────────

export const COALESCE_WINDOW_MS = 1000
export const COALESCE_ID_CAP = 200

export interface CoalescedUpdate {
  collection: string
  /** Null on a merged message: the ids are in `items` (or `many`). */
  item: null
  items: Array<string | number> | null
  many: boolean
  count: number
  action?: 'create' | 'update' | 'delete'
  changed_fields?: string[]
  coalesced: true
  _seq?: number
}

/** Collapse several `collection:update` payloads for one collection into one message. */
export function mergeUpdates(
  collection: string,
  list: Array<Record<string, unknown>>,
  cap = COALESCE_ID_CAP
): CoalescedUpdate {
  const ids: Array<string | number> = []
  const seen = new Set<string>()
  const actions = new Set<string>()
  const fields = new Set<string>()
  let anyAllFields = false
  let seq: number | undefined
  for (const p of list) {
    const id = p.item as string | number | null | undefined
    if (id != null && !seen.has(String(id))) {
      seen.add(String(id))
      ids.push(id)
    }
    if (typeof p.action === 'string') actions.add(p.action)
    const cf = p.changed_fields
    if (Array.isArray(cf) && cf.length) for (const f of cf) fields.add(String(f))
    else anyAllFields = true
    if (typeof p._seq === 'number' && (seq == null || p._seq > seq)) seq = p._seq
  }
  const many = ids.length > cap
  const out: CoalescedUpdate = {
    collection,
    item: null,
    items: many ? null : ids,
    many,
    count: ids.length,
    coalesced: true
  }
  if (actions.size === 1) out.action = [...actions][0] as CoalescedUpdate['action']
  // A message with no field list means "anything may have changed" — the union stays open.
  if (!anyAllFields && fields.size) out.changed_fields = [...fields].slice(0, 50)
  if (seq != null) out._seq = seq
  return out
}

export interface Coalescer {
  /** Hand one `collection:update` payload over; it goes out now or with the window. */
  push(payload: Record<string, unknown>): void
  /** Drop pending windows (socket gone). */
  dispose(): void
}

/**
 * Per-socket coalescer. Leading edge: the first event for a collection is sent at once and
 * opens a window. Events inside the window are held; when it closes, one held event goes out
 * as it was and several go out as ONE merged message, and a new window opens — so a
 * sustained import costs each client one message per collection per window, never more.
 */
export function createCoalescer(opts: {
  send: (payload: Record<string, unknown>) => void
  windowMs?: number
  cap?: number
  onCollapse?: (n: number) => void
}): Coalescer {
  const windowMs = opts.windowMs ?? COALESCE_WINDOW_MS
  const windows = new Map<string, { buf: Array<Record<string, unknown>>; timer: unknown }>()
  let disposed = false

  const open = (c: string) => {
    const timer = setTimeout(() => close(c), windowMs)
    ;(timer as { unref?: () => void }).unref?.()
    windows.set(c, { buf: [], timer })
  }
  const close = (c: string) => {
    const w = windows.get(c)
    windows.delete(c)
    if (!w || disposed || w.buf.length === 0) return
    if (w.buf.length === 1) opts.send(w.buf[0])
    else {
      opts.send(mergeUpdates(c, w.buf, opts.cap) as unknown as Record<string, unknown>)
      opts.onCollapse?.(w.buf.length)
    }
    open(c)
  }

  return {
    push(payload) {
      if (disposed) return
      const c = String(payload.collection ?? '')
      const w = windows.get(c)
      if (!w) {
        opts.send(payload)
        open(c)
        return
      }
      w.buf.push(payload)
    },
    dispose() {
      disposed = true
      for (const w of windows.values()) clearTimeout(w.timer as ReturnType<typeof setTimeout>)
      windows.clear()
    }
  }
}
