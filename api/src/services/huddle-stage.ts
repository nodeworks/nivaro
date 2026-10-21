import type { Server, Socket } from 'socket.io'
import type { User } from '../types.js'
import { inSocketTenant } from './socket-tenant.js'

/**
 * Stage extras for huddles (#2857 reactions + raised hands, #2858 camera).
 *
 * Reactions are fire-and-forget: `huddle:react {room, emoji}` from someone in
 * the room's huddle goes to everyone in it as `huddle:react {room, from, user,
 * emoji}` — ids and one of six emoji, nothing else. One per second per socket;
 * anything faster is dropped before canSeeRoom is even asked.
 *
 * A raised hand and a camera are participant state, so they ride the existing
 * `huddle:state` (`hand: boolean`, `camera: <stream id> | null`) and land in the
 * roster as `hand_at` / `cam` / `cam_at`. `huddle:hands_down {room}` lowers
 * every hand — there is no host in v1, anyone in the huddle may.
 *
 * Media never crosses the server: `cam` is only the browser's MediaStream id,
 * which lets the others tell the camera track from a screen share.
 */

/** The six reactions; the client's list in huddle-reactions.ts is its twin. */
export const HUDDLE_REACTIONS = ['👍', '👏', '😂', '🎉', '❤️', '🤔'] as const
export const STAGE_MIN_GAP_MS = 1000
const CAM_ID = /^[A-Za-z0-9{}_-]{1,64}$/

export interface StageFields {
  /** When the hand went up (ms), null = not raised. Raise order = this order. */
  hand_at: number | null
  /** The camera's MediaStream id while the person has their camera on. */
  cam: string | null
  /** When the camera went on — the first four cameras stay live (#2858). */
  cam_at: number | null
}

function num(v: unknown): number | null {
  const n = Number(v)
  return v != null && Number.isFinite(n) && n > 0 ? n : null
}

/** Stage fields read back from a stored meta row (old rows have none). */
export function stageFieldsFrom(m: Partial<Record<keyof StageFields, unknown>>): StageFields {
  const cam = typeof m.cam === 'string' && CAM_ID.test(m.cam) ? m.cam : null
  return { hand_at: num(m.hand_at), cam, cam_at: cam ? num(m.cam_at) : null }
}

/** Apply a huddle:state payload's `hand` / `camera` to the stored fields. */
export function stagePatch(
  payload: { hand?: unknown; camera?: unknown },
  prev: Partial<Record<keyof StageFields, unknown>>,
  now = Date.now()
): StageFields {
  const before = stageFieldsFrom(prev)
  let hand_at = before.hand_at
  if (payload.hand === true) hand_at = before.hand_at ?? now
  else if (payload.hand === false) hand_at = null
  let cam = before.cam
  let cam_at = before.cam_at
  if (payload.camera === null || payload.camera === false) {
    cam = null
    cam_at = null
  } else if (typeof payload.camera === 'string' && CAM_ID.test(payload.camera)) {
    cam_at = cam ? (cam_at ?? now) : now
    cam = payload.camera
  }
  return { hand_at, cam, cam_at }
}

export interface StageContext {
  /** The room this socket's huddle is in (undefined = none). */
  room(): string | undefined
  /** Re-asks canSeeRoom; removes the person (and says so) when it fails. */
  stillAllowed(user: User, room: string): Promise<boolean>
  broadcast(room: string): Promise<unknown>
  scopedRoomNow(room: string): string | null
  /** The room's huddle meta hash key. */
  metaKey(room: string): string
  redis: {
    hgetall(key: string): Promise<Record<string, string>>
    hset(key: string, field: string, value: string): Promise<unknown>
  }
  warn(obj: Record<string, unknown>, msg: string): void
}

/** Wire huddle:react and huddle:hands_down onto one connection. */
export function registerHuddleStage(
  io: Pick<Server, 'to'>,
  socket: Socket,
  getUser: () => User | null,
  ctx: StageContext
): void {
  let lastReact = 0
  let lastHandsDown = 0

  socket.on(
    'huddle:react',
    inSocketTenant(socket, async (payload: { room?: unknown; emoji?: unknown }) => {
      const room = payload?.room
      const emoji = payload?.emoji
      if (typeof room !== 'string' || ctx.room() !== room) return
      if (typeof emoji !== 'string' || !(HUDDLE_REACTIONS as readonly string[]).includes(emoji)) {
        return
      }
      const now = Date.now()
      if (now - lastReact < STAGE_MIN_GAP_MS) return
      lastReact = now
      const user = getUser()
      if (!user) return
      try {
        if (!(await ctx.stillAllowed(user, room))) return
        const h = ctx.scopedRoomNow(`huddle:${room}`)
        if (h) io.to(h).emit('huddle:react', { room, from: socket.id, user: user.id, emoji })
      } catch (err) {
        ctx.warn({ err, room }, 'huddle:react failed')
      }
    })
  )

  socket.on(
    'huddle:hands_down',
    inSocketTenant(socket, async (payload: { room?: unknown }) => {
      const room = payload?.room
      if (typeof room !== 'string' || ctx.room() !== room) return
      const now = Date.now()
      if (now - lastHandsDown < STAGE_MIN_GAP_MS) return
      lastHandsDown = now
      const user = getUser()
      if (!user) return
      try {
        if (!(await ctx.stillAllowed(user, room))) return
        const key = ctx.metaKey(room)
        const meta = await ctx.redis.hgetall(key)
        let changed = false
        for (const [sid, raw] of Object.entries(meta)) {
          let m: Record<string, unknown>
          try {
            m = JSON.parse(raw) as Record<string, unknown>
          } catch {
            continue
          }
          if (m.hand_at == null) continue
          m.hand_at = null
          await ctx.redis.hset(key, sid, JSON.stringify(m))
          changed = true
        }
        if (changed) await ctx.broadcast(room)
      } catch (err) {
        ctx.warn({ err, room }, 'huddle:hands_down failed')
      }
    })
  )
}
