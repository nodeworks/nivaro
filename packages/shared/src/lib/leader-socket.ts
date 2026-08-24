/**
 * Tab leader election (#277): with many tabs open, only ONE holds the real
 * Socket.io connection; the rest ride a BroadcastChannel. Halves server socket
 * load and keeps events consistent across tabs.
 *
 * Election: localStorage heartbeat lock (`nvr-sock-leader:<key>` = "id:ts").
 * The leader refreshes its claim every 2s; followers watch for staleness
 * (>6s) and race to claim it. BroadcastChannel carries events leader→followers
 * and emit requests follower→leader. No BroadcastChannel (old browser,
 * cross-origin iframe) → every tab is its own leader, the historic behaviour.
 */

export interface LeaderSocketHandle {
  isLeader(): boolean
  /** Fires on every inbound socket event (leader: direct; follower: relayed). */
  onEvent(cb: (event: string, payload: any) => void): () => void
  /** Emit toward the server (follower forwards to the leader). */
  emit(event: string, payload?: any): void
  destroy(): void
}

interface LeaderCallbacks {
  /** Called when this tab becomes leader — create the real socket, wire onAny → deliver. */
  becomeLeader(
    deliver: (event: string, payload: any) => void,
    emit: { current: (event: string, payload: any) => void }
  ): void
  /** Called when this tab loses/abdicates leadership — tear the socket down. */
  resignLeader(): void
}

const HEARTBEAT_MS = 2000
const STALE_MS = 6000

export function createLeaderSocket(key: string, cbs: LeaderCallbacks): LeaderSocketHandle {
  const id = Math.random().toString(36).slice(2)
  const lockKey = `nvr-sock-leader:${key}`
  const listeners = new Set<(event: string, payload: any) => void>()
  const serverEmit = { current: (_e: string, _p: any) => {} }
  let leader = false
  let destroyed = false
  let timer: ReturnType<typeof setInterval> | null = null

  const bc: BroadcastChannel | null =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`nvr-sock:${key}`) : null

  const deliverLocal = (event: string, payload: any) => {
    for (const cb of listeners) {
      try {
        cb(event, payload)
      } catch {
        /* one listener must not break the rest */
      }
    }
  }

  const deliver = (event: string, payload: any) => {
    deliverLocal(event, payload)
    bc?.postMessage({ kind: 'event', event, payload })
  }

  const readLock = (): { id: string; ts: number } | null => {
    try {
      const raw = localStorage.getItem(lockKey)
      if (!raw) return null
      const i = raw.lastIndexOf(':')
      return { id: raw.slice(0, i), ts: Number(raw.slice(i + 1)) }
    } catch {
      return null
    }
  }

  const claim = () => {
    try {
      localStorage.setItem(lockKey, `${id}:${Date.now()}`)
    } catch {
      /* storage unavailable — stand-alone leader below */
    }
  }

  const promote = () => {
    if (leader || destroyed) return
    leader = true
    claim()
    cbs.becomeLeader(deliver, serverEmit)
  }

  const demote = () => {
    if (!leader) return
    leader = false
    cbs.resignLeader()
  }

  const tick = () => {
    if (destroyed) return
    const lock = readLock()
    if (leader) {
      if (lock && lock.id !== id && Date.now() - lock.ts < STALE_MS) {
        // Someone else won a race — defer to them.
        demote()
      } else {
        claim()
      }
      return
    }
    if (!lock || Date.now() - lock.ts > STALE_MS) {
      // Stale or absent — race to claim, confirm next tick to avoid double win.
      claim()
      setTimeout(() => {
        const after = readLock()
        if (after?.id === id) promote()
      }, 150)
    }
  }

  if (!bc) {
    // No cross-tab channel: this tab must own its own socket.
    promote()
  } else {
    bc.onmessage = (ev) => {
      const msg = ev.data
      if (!msg || destroyed) return
      if (msg.kind === 'event' && !leader) deliverLocal(msg.event, msg.payload)
      if (msg.kind === 'emit' && leader) serverEmit.current(msg.event, msg.payload)
    }
    tick()
    timer = setInterval(tick, HEARTBEAT_MS)
    window.addEventListener('beforeunload', () => {
      if (leader) {
        try {
          localStorage.removeItem(lockKey)
        } catch {
          /* noop */
        }
      }
    })
  }

  return {
    isLeader: () => leader,
    onEvent(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    emit(event, payload) {
      if (leader) serverEmit.current(event, payload)
      else bc?.postMessage({ kind: 'emit', event, payload })
    },
    destroy() {
      destroyed = true
      if (timer) clearInterval(timer)
      demote()
      try {
        const lock = readLock()
        if (lock?.id === id) localStorage.removeItem(lockKey)
      } catch {
        /* noop */
      }
      bc?.close()
    }
  }
}
