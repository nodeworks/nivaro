import type { Server, Socket } from 'socket.io'
import type { User } from '../types.js'
import { inSocketTenant } from './socket-tenant.js'

/**
 * Point and draw in a large huddle (#2856 on the SFU, #2859). In a mesh the
 * marks travel browser to browser over a data channel; on the LiveKit SFU
 * there is no mesh, and the SFU token deliberately cannot publish data, so
 * the marks ride the chat socket instead:
 *
 *   huddle:mark {room, t, s, x?, y?, id?, tool?, k?, p?, c?}
 *     → huddle:mark {room, from, t, s, …} to the OTHER sockets in the roster.
 *
 * The payload is normalised coordinates (0–1 over the shared picture), the
 * tool, a stroke id and a colour index — nothing else is relayed, and nothing
 * is stored. Who drew is the sending socket, set here, never a field the
 * browser chooses. Drawing is chatty (a pointer moves ~30 times a second), so
 * each socket gets two token buckets — messages and bytes — and one message
 * carries at most MARK_MAX_POINTS points (the client splits a longer stroke
 * under the same stroke id). Over budget = dropped, and the sender hears one
 * `huddle:mark:slow {room}` per MARK_SLOW_NOTICE_MS. canSeeRoom plus the
 * roster read are re-asked at most every MARK_ACCESS_TTL_MS rather than on
 * every message; a refused check removes the person like every other huddle
 * event. Anything that removes someone from a huddle (leave, a stale prune, a
 * canSeeRoom refusal) calls invalidateHuddleMarks, so every socket on this
 * process re-reads the roster on its next mark instead of waiting out the TTL.
 * Another replica's removal still waits out the TTL (at most 2 s).
 *
 * The validator is the twin of parseDrawObject in the client's huddle-draw.ts.
 */

/** A burst of this many marks, refilled at MARK_PER_SEC. */
export const MARK_BURST = 40
export const MARK_PER_SEC = 30
/** Bytes per socket: a burst of MARK_BYTES_BURST, refilled at MARK_BYTES_PER_SEC. */
export const MARK_BYTES_BURST = 32_768
export const MARK_BYTES_PER_SEC = 16_384
/** Points one stroke message may carry (the client splits longer strokes). */
export const MARK_MAX_POINTS = 64
/** The sender hears "slow down" at most this often. */
export const MARK_SLOW_NOTICE_MS = 5000
/** How long one canSeeRoom answer + roster read covers this socket's marks. */
export const MARK_ACCESS_TTL_MS = 2000
/** A stroke's point index stays under this (the client's twin keeps its 600-point cap). */
const MAX_POINTS = 600
/** The colour index is a slot of the chat avatar palette. */
const MAX_COLOR = 15

const ID = /^[A-Za-z0-9_-]{1,64}$/
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export type HuddleMark = (
  | { t: 'pt'; s: string; x: number; y: number }
  | { t: 'st'; s: string; id: string; tool: 'pen' | 'arrow'; k: number; p: number[] }
  | { t: 'clr'; s: string }
) & { c?: number }

/** Validate one mark from a browser; anything off-shape (or any extra field) is dropped. */
export function parseMark(raw: unknown): HuddleMark | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (typeof m.s !== 'string' || !ID.test(m.s)) return null
  let c: number | undefined
  if (m.c != null) {
    if (!Number.isInteger(m.c) || (m.c as number) < 0 || (m.c as number) > MAX_COLOR) return null
    c = m.c as number
  }
  const withColor = <T extends object>(v: T): T & { c?: number } => (c == null ? v : { ...v, c })
  if (m.t === 'clr') return withColor({ t: 'clr' as const, s: m.s })
  if (m.t === 'pt') {
    if (!finite(m.x) || !finite(m.y)) return null
    return withColor({ t: 'pt' as const, s: m.s, x: clamp01(m.x), y: clamp01(m.y) })
  }
  if (m.t === 'st') {
    if (typeof m.id !== 'string' || !ID.test(m.id)) return null
    if (m.tool !== 'pen' && m.tool !== 'arrow') return null
    if (!finite(m.k) || m.k < 0 || m.k >= MAX_POINTS || !Number.isInteger(m.k)) return null
    if (!Array.isArray(m.p) || m.p.length % 2 || m.p.length > MARK_MAX_POINTS * 2) return null
    if (!m.p.every(finite)) return null
    return withColor({
      t: 'st' as const,
      s: m.s,
      id: m.id,
      tool: m.tool as 'pen' | 'arrow',
      k: m.k,
      p: (m.p as number[]).map(clamp01)
    })
  }
  return null
}

/** A token bucket: `burst` at once, refilled at `perSec`; false = drop this one (`cost` tokens). */
export function markBucket(burst = MARK_BURST, perSec = MARK_PER_SEC) {
  let tokens = burst
  let last: number | null = null
  return (now = Date.now(), cost = 1): boolean => {
    if (last != null) tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSec)
    last = now
    if (tokens < cost) return false
    tokens -= cost
    return true
  }
}

// ── Removal invalidates every cached recipient list for the room (process-local) ──
let markSeq = 0
const invalidated = new Map<string, { seq: number; at: number }>()
const markKey = (tenant: string | null, room: string) => `${tenant || '-'}|${room}`

/**
 * Someone left the room's huddle, was pruned, or was refused by canSeeRoom: every socket's
 * cached recipient list for it is stale now. Keyed by tenant + room (module state is shared by
 * every cloud tenant); entries older than the TTL are dropped, since every cache has expired
 * by then anyway.
 */
export function invalidateHuddleMarks(tenant: string | null, room: string, now = Date.now()) {
  for (const [k, v] of invalidated) if (now - v.at > MARK_ACCESS_TTL_MS * 2) invalidated.delete(k)
  invalidated.set(markKey(tenant, room), { seq: ++markSeq, at: now })
}

function invalidatedSince(tenant: string | null, room: string, seq: number): boolean {
  return (invalidated.get(markKey(tenant, room))?.seq ?? 0) > seq
}

export interface MarkContext {
  /** The room this socket's huddle is in (undefined = none). */
  room(): string | undefined
  /** The socket's tenant (null self-hosted), for the invalidation key. */
  tenant(): string | null
  /** Re-asks canSeeRoom; removes the person (and says so) when it fails. */
  stillAllowed(user: User, room: string): Promise<boolean>
  /** The huddle's roster (socket ids). */
  peers(room: string): Promise<Array<{ socket: string }>>
  warn(obj: Record<string, unknown>, msg: string): void
}

/** Wire huddle:mark onto one connection. */
export function registerHuddleMarks(
  io: Pick<Server, 'to'>,
  socket: Socket,
  getUser: () => User | null,
  ctx: MarkContext,
  now: () => number = Date.now
): void {
  type Gate = { room: string; until: number; seq: number; to: string[] } | null
  const bucket = markBucket()
  const bytes = markBucket(MARK_BYTES_BURST, MARK_BYTES_PER_SEC)
  let lastSlow = Number.NEGATIVE_INFINITY
  let gate: Gate = null
  let pending: Promise<Gate> | null = null

  /** Over budget: drop it, and tell the sender (once per MARK_SLOW_NOTICE_MS). */
  function slow(room: string) {
    const t = now()
    if (t - lastSlow < MARK_SLOW_NOTICE_MS) return
    lastSlow = t
    socket.emit('huddle:mark:slow', { room })
  }

  /** canSeeRoom + "am I in the roster", and who else is: one answer per TTL. */
  async function check(user: User, room: string): Promise<Gate> {
    // Taken first: a removal while this check runs makes the answer stale at once.
    const seq = markSeq
    if (!(await ctx.stillAllowed(user, room))) return null
    const peers = await ctx.peers(room)
    if (!peers.some((p) => p.socket === socket.id)) return null
    const to = peers.map((p) => p.socket).filter((s) => s !== socket.id)
    return { room, until: now() + MARK_ACCESS_TTL_MS, seq, to }
  }

  const fresh = (g: Gate, room: string): g is NonNullable<Gate> =>
    !!g && g.room === room && now() < g.until && !invalidatedSince(ctx.tenant(), room, g.seq)

  const handler = async (payload: { room?: unknown } & Record<string, unknown>): Promise<void> => {
    const room = payload?.room
    if (typeof room !== 'string' || ctx.room() !== room) return
    if (!bucket(now())) return slow(room)
    const mark = parseMark(payload)
    if (!mark) return
    const out = { ...mark, room, from: socket.id }
    if (!bytes(now(), Buffer.byteLength(JSON.stringify(out), 'utf8'))) return slow(room)
    const user = getUser()
    if (!user) return
    try {
      if (!fresh(gate, room)) {
        pending ??= check(user, room).finally(() => {
          pending = null
        })
        gate = await pending
        if (!fresh(gate, room)) return
      }
      if (ctx.room() !== room || !gate.to.length) return
      io.to(gate.to).emit('huddle:mark', out)
    } catch (err) {
      gate = null
      ctx.warn({ err, room }, 'huddle:mark failed')
    }
  }

  socket.on('huddle:mark', inSocketTenant(socket, handler))
}
