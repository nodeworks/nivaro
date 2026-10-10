import type { Server, Socket } from 'socket.io'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { inSocketTenant } from './socket-tenant.js'

/**
 * Watch a session replay together (#1399).
 *
 * An admin opens a replay and shares a key; every admin who joins room
 * `replay:<key>` follows the sharer's playhead. The server keeps no state of
 * its own — who is in the room, and who leads, lives on each socket's `data`
 * and is read with fetchSockets(), which the Redis adapter answers across
 * nodes — so a watch party works whichever API node each admin landed on.
 *
 *   replay:join  { key, recording, lead? }  → replay:joined { key, recording, leader }
 *                                             or replay:denied { key, reason }
 *   replay:state { key, playing, time, speed }  (leader only) → the others
 *   replay:leave { key }
 *   → replay:roster { key, viewers: [{ id, name, leader }] } on every change
 *   → replay:need-state { key } when someone joins; the leader answers with replay:state
 *
 * Admins only (role admin_access), like every replay read. The recording must
 * exist for the joiner (in the cloud: in the joiner's own tenant), and every
 * socket in a room watches the same recording — a key is not a way into
 * someone else's replay.
 */

export const REPLAY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/
const UUIDISH_RE = /^[0-9A-Za-z-]{8,64}$/

export function replayRoom(key: string): string {
  return `replay:${key}`
}

export interface WatchData {
  key: string
  recording: string
  user: { id: string; name: string }
  leader: boolean
}

export interface Viewer {
  id: string
  name: string
  leader: boolean
}

/** One entry per admin (two tabs of the same person are one viewer), leader if any tab leads. */
export function rosterFrom(datas: Array<WatchData | undefined>, key: string): Viewer[] {
  const byUser = new Map<string, Viewer>()
  for (const d of datas) {
    if (!d || d.key !== key) continue
    const cur = byUser.get(d.user.id)
    if (cur) cur.leader = cur.leader || d.leader
    else byUser.set(d.user.id, { id: d.user.id, name: d.user.name, leader: d.leader })
  }
  return [...byUser.values()].sort(
    (a, b) => Number(b.leader) - Number(a.leader) || a.name.localeCompare(b.name)
  )
}

/** Playhead from the leader, clamped to something a player can use. */
export function cleanState(p: unknown): { playing: boolean; time: number; speed: number } | null {
  const o = (p ?? {}) as { playing?: unknown; time?: unknown; speed?: unknown }
  const time = Number(o.time)
  if (!Number.isFinite(time) || time < 0) return null
  const speed = Number(o.speed)
  return {
    playing: o.playing === true,
    time: Math.min(Math.round(time), 24 * 3_600_000),
    speed: Number.isFinite(speed) && speed > 0 && speed <= 16 ? speed : 1
  }
}

function nameOf(u: User): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
}

export interface ReplayWatchDeps {
  isAdmin(user: User): Promise<boolean>
  recordingExists(id: string): Promise<boolean>
}

const defaultDeps: ReplayWatchDeps = {
  async isAdmin(user) {
    if (!user.role) return false
    const role = await db('nivaro_roles').where({ id: user.role }).first('admin_access')
    return !!role?.admin_access
  },
  async recordingExists(id) {
    const row = await db('nivaro_session_recordings').where({ id }).first('id')
    return !!row
  }
}

type RoomSocket = { id: string; data: { replayWatch?: WatchData } }

/** Wire the replay:* events onto one connection. `getUser` is the socket's authenticated user. */
export function registerReplayWatch(
  io: Pick<Server, 'in' | 'to'>,
  socket: Socket,
  getUser: () => User | null,
  deps: ReplayWatchDeps = defaultDeps
): void {
  const data = () => (socket.data as { replayWatch?: WatchData }).replayWatch
  const setData = (d: WatchData | undefined) => {
    ;(socket.data as { replayWatch?: WatchData }).replayWatch = d
  }

  async function members(key: string): Promise<RoomSocket[]> {
    return (await io.in(replayRoom(key)).fetchSockets()) as unknown as RoomSocket[]
  }

  async function broadcastRoster(key: string) {
    try {
      const viewers = rosterFrom(
        (await members(key)).map((s) => s.data?.replayWatch),
        key
      )
      io.to(replayRoom(key)).emit('replay:roster', { key, viewers })
    } catch {
      /* a roster is decoration — the next change sends a fresh one */
    }
  }

  function leave() {
    const d = data()
    if (!d) return
    setData(undefined)
    socket.leave(replayRoom(d.key))
    void broadcastRoster(d.key)
  }

  const deny = (key: unknown, reason: string): void => {
    socket.emit('replay:denied', { key: typeof key === 'string' ? key : null, reason })
  }

  socket.on(
    'replay:join',
    inSocketTenant(
      socket,
      async (payload: { key?: unknown; recording?: unknown; lead?: unknown }) => {
        const key = payload?.key
        const recording = payload?.recording
        const user = getUser()
        if (typeof key !== 'string' || !REPLAY_KEY_RE.test(key)) return deny(key, 'bad-key')
        if (typeof recording !== 'string' || !UUIDISH_RE.test(recording)) {
          return deny(key, 'bad-recording')
        }
        if (!user) return deny(key, 'not-signed-in')
        try {
          if (!(await deps.isAdmin(user))) return deny(key, 'admins-only')
          if (!(await deps.recordingExists(recording))) return deny(key, 'no-recording')
        } catch {
          return deny(key, 'unavailable')
        }
        const others = (await members(key)).filter((s) => s.id !== socket.id)
        const roomRecording = others.find((s) => s.data?.replayWatch)?.data.replayWatch?.recording
        if (roomRecording && roomRecording !== recording) return deny(key, 'other-recording')
        const hasLeader = others.some(
          (s) => s.data?.replayWatch?.key === key && s.data.replayWatch.leader
        )
        // One room per socket: joining another leaves the last.
        const prev = data()
        if (prev && prev.key !== key) leave()
        const leader = payload?.lead === true && !hasLeader
        setData({ key, recording, user: { id: user.id, name: nameOf(user) }, leader })
        socket.join(replayRoom(key))
        socket.emit('replay:joined', { key, recording, leader })
        await broadcastRoster(key)
        if (!leader) io.to(replayRoom(key)).emit('replay:need-state', { key })
      }
    )
  )

  socket.on('replay:state', (payload: { key?: unknown }) => {
    const d = data()
    if (!d?.leader || payload?.key !== d.key) return
    const state = cleanState(payload)
    if (!state) return
    socket.to(replayRoom(d.key)).emit('replay:state', { key: d.key, ...state, by: d.user.name })
  })

  socket.on('replay:leave', (payload: { key?: unknown }) => {
    if (payload?.key === data()?.key) leave()
  })

  socket.on('disconnect', () => {
    const d = data()
    if (d) void broadcastRoster(d.key)
  })
}
