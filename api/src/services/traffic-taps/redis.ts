// api/src/services/traffic-taps/redis.ts
/**
 * Topology tap `redis` (#1148): commands per second on the app's Redis client and which key
 * families they touch (query cache, sessions, idempotency, transition guard, scheduler lease…),
 * counted from an ioredis sendCommand hook. Key NAMES are never kept — only the family a prefix
 * maps to, so no session id or token reaches the map.
 */
import { registerTrafficTap, SecondRing, tapState } from '../traffic-taps.js'
import { MinuteTotals } from './util.js'

export const REDIS_TAP = 'redis'

/** Ordered prefix → family; the first match wins. */
const FAMILIES: Array<[string, string]> = [
  ['sess:revoked:', 'session revocations'],
  ['sess:', 'sessions'],
  ['cq:', 'query cache'],
  ['nvr:idem', 'idempotency keys'],
  ['nvr:transition', 'transition guard'],
  ['nvr:cron', 'scheduler lease'],
  ['nvr:ev', 'event journal'],
  ['nvr:keyrl', 'API key rate limits'],
  ['nvr:masq', 'masquerade markers'],
  ['masq:', 'masquerade tokens'],
  ['ws:token', 'socket tokens'],
  ['keysim:', 'run-as-key tokens'],
  ['nvr:autofill', 'autofill proposals'],
  ['nvr:aichat', 'AI answer cache'],
  ['nvr:queue-backfill', 'queue backfill locks'],
  ['nvr:bulk', 'bulk run results'],
  ['nvr:boots', 'boot phases'],
  ['nvr:instance', 'instance roster'],
  ['nvr:chatreply', 'chat reply tokens'],
  ['nvr:linkprev', 'link previews'],
  ['nvr:epoch', 'cache epochs'],
  ['bull:', 'job queues'],
  ['socket.io', 'socket adapter']
]

/** The key family of a Redis key (never the key itself). */
export function redisFamily(key: unknown): string {
  const k =
    typeof key === 'string' ? key : Buffer.isBuffer(key) ? key.toString('latin1', 0, 40) : ''
  if (!k) return 'no key'
  for (const [p, f] of FAMILIES) if (k.startsWith(p)) return f
  const m = /^([a-z]+:[a-z-]+|[a-z-]+):/i.exec(k)
  return m ? `${m[1].toLowerCase().slice(0, 30)}:*` : 'other'
}

interface RedisState {
  total: SecondRing
  families: MinuteTotals
  commands: MinuteTotals
}
function state(): RedisState {
  return tapState<RedisState>(REDIS_TAP, () => ({
    total: new SecondRing(1, Math.floor(Date.now() / 1000)),
    families: new MinuteTotals(30),
    commands: new MinuteTotals(30)
  }))
}

/** Count one command (called from the client hook; must never throw into Redis). */
export function noteRedisCommand(name: string, key: unknown, at = Date.now()): void {
  if (process.env.CLOUD_META_DB_URL) return
  try {
    const s = state()
    const sec = Math.floor(at / 1000)
    s.total.bump(sec)
    s.families.add(redisFamily(key), sec)
    s.commands.add(
      String(name || '?')
        .toLowerCase()
        .slice(0, 24),
      sec
    )
  } catch {
    /* never */
  }
}

interface CommandLike {
  name?: string
  args?: unknown[]
}
const PATCHED = Symbol.for('nivaro.trafficRedisHook')

/** Wrap a client's sendCommand once. Pub/sub-only clients (the socket adapter) are not wrapped. */
export function instrumentRedis(client: unknown): void {
  const c = client as Record<string | symbol, unknown> & {
    sendCommand?: (cmd: CommandLike, ...rest: unknown[]) => unknown
  }
  if (!c || typeof c.sendCommand !== 'function' || c[PATCHED]) return
  const orig = c.sendCommand.bind(c)
  c.sendCommand = (cmd: CommandLike, ...rest: unknown[]) => {
    noteRedisCommand(cmd?.name ?? '?', cmd?.args?.[0])
    return orig(cmd, ...rest)
  }
  c[PATCHED] = true
}

registerTrafficTap({
  id: REDIS_TAP,
  frame(sec) {
    const n = state().total.second(sec)[0] ?? 0
    return n ? { cps: n } : undefined
  },
  snapshot(windowS, sec) {
    const s = state()
    const total = s.total.sum(windowS, sec)[0] ?? 0
    if (!total) return undefined
    return {
      commands: total,
      cps: Math.round((total / windowS) * 10) / 10,
      families: s.families.entries(windowS, sec).map(([family, n]) => ({ family, n })),
      top_commands: s.commands
        .entries(windowS, sec)
        .slice(0, 8)
        .map(([name, n]) => ({ name, n }))
    }
  },
  sweep(sec) {
    const s = state()
    s.families.sweep(sec)
    s.commands.sweep(sec)
  }
})
