/**
 * Realtime verification hooks on one socket — the socket plugin's single attach point for:
 *
 *   #2463 socket chaos (socket-chaos.ts): faults on the packets this socket is written;
 *   #2760 leak auditor (realtime-leak-audit.ts): a sample of those packets checked later;
 *   #2477 client acknowledgements (`rt:ack`, realtime-delivery-slo.ts);
 *   #2478 socket replay mirror rooms (`replay:join`, socket-replay.ts).
 *
 * `attachSocketVerification` takes the plugin's per-packet write and returns the one to use; everything else
 * registers its own listeners. When nothing is switched on, the wrapper is two comparisons.
 */
import type { Socket } from 'socket.io'
import type { User } from '../types.js'
import { acceptAck } from './realtime-delivery-slo.js'
import { sampleLeakAudit } from './realtime-leak-audit.js'
import type { SocketAccessHooks } from './socket-access.js'
import { ensureChaosListener, noteChaosInbound, wrapChaosWrite } from './socket-chaos.js'
import { inSocketTenant } from './socket-tenant.js'

type Write = (p: unknown, opts: Record<string, unknown>) => void

const REPLAY_ROOMS_PER_SOCKET = 50

export function attachSocketVerification(
  socket: Socket,
  write: Write,
  deps: { rtt(): number | null; room(): string | null }
): Write {
  const user = (): User | null =>
    (socket.data?.nvrAccess as SocketAccessHooks | undefined)?.user() ?? null
  const userId = () => {
    const u = user()
    return u ? String(u.id) : null
  }
  ensureChaosListener(socket.nsp?.server ?? null)

  socket.use((packet, next) => {
    if (typeof packet?.[0] === 'string') noteChaosInbound(socket, packet[0], userId())
    next()
  })
  // #2477 — only a signed-in socket's ack counts (realtime-delivery-slo.ts checks the rest).
  socket.on('rt:ack', (payload: unknown) => {
    const u = userId()
    if (u) void acceptAck(u, payload, deps.rtt()).catch(() => {})
  })
  let replayRooms = 0
  socket.on(
    'replay:join',
    inSocketTenant(socket, async (payload: { run?: string; secret?: string; room?: string }) => {
      const u = user()
      if (!u || replayRooms >= REPLAY_ROOMS_PER_SOCKET) return
      const room = typeof payload?.room === 'string' ? payload.room.slice(0, 200) : ''
      if (!room) return
      const [{ isAdminRole }, replay] = await Promise.all([
        import('./permissions.js'),
        import('./socket-replay.js')
      ])
      if (!(await isAdminRole(u))) return
      if (!replay.replayJoinAllowed(String(payload?.run ?? ''), payload?.secret)) return
      replayRooms++
      socket.join(replay.mirrorRoom(String(payload.run), room))
    })
  )

  const chaosWrite = wrapChaosWrite(socket, write, userId)
  const audited = inSocketTenant(socket, async (fn: () => Promise<void>) => fn())
  return (p, opts) => {
    if (typeof p === 'string') sampleLeakAudit(p, deps.room(), user, (fn) => void audited(fn))
    chaosWrite(p, opts)
  }
}
