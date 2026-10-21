// biome-ignore-all lint/suspicious/noConsole: command-line tool, the console is its output
/**
 * `pnpm --filter @nivaro/api run realtime:replay -- --capture <file.json> --target <staging url>
 *    --token <admin bearer on the target> [--speed 1|2|5] [--clients 200] [--out report.json]
 *    [--dry-run]` (#2478)
 *
 * Replays a socket capture (GET /api/realtime/replay/capture on production, ids only) against
 * STAGING: simulated socket clients (as the realtime load test #1754 builds them) sign in with
 * one-time ws-tokens for --token's user, join mirror rooms in the captured room mix, and the
 * target emits the captured events into those rooms through its normal emit path at the chosen
 * speed. Prints delivery latency (p50/p95/p99), loss, and the target's API CPU, event-loop delay
 * and Redis load over the run (services/socket-replay.ts).
 *
 * Refused: the capture's own origin, this checkout's PUBLIC_URL / ADMIN_URL / DB_HOST, every
 * host in a Production environment of the Environments registry, TRAFFIC_REPLAY_SHARED_HOSTS.
 * The target also refuses unless it runs with REALTIME_REPLAY=on. Smoke scale by default
 * (≤ 200 clients); --full-scale --confirm-dedicated <host> lifts it to 2000.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { config } from '../config.js'
import { db } from '../db/index.js'
import {
  planReplayClients,
  planReplayEmits,
  type SocketCapture,
  socketReplayRefusal
} from '../services/socket-replay.js'

const requireFrom = (pkg: string) => createRequire(new URL(pkg, import.meta.url))

const args = process.argv.slice(2)
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const has = (name: string) => args.includes(`--${name}`)

const SMOKE_CLIENTS = 200
const FULL_CLIENTS = 2000

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10
}

/** Hosts in a Production environment of the registry (fails closed: a read error refuses). */
async function productionHosts(): Promise<string[]> {
  const rows = (await db('nivaro_environment_components as c')
    .join('nivaro_environments as e', 'e.id', 'c.environment')
    .whereNotNull('c.base_url')
    .select('e.name', 'c.base_url')) as Array<{ name: string; base_url: string }>
  return rows.filter((r) => /prod/i.test(r.name)).map((r) => r.base_url)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let exitCode = 0
const sockets: any[] = []
try {
  const file = arg('capture')
  if (!file) throw new Error('--capture <file.json> is required (GET /api/realtime/replay/capture)')
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { data?: SocketCapture } & SocketCapture
  const capture: SocketCapture = raw.data ?? raw
  if (capture.version !== 1 || !Array.isArray(capture.events))
    throw new Error('the capture file is not a socket capture (version 1)')
  const target = String(arg('target') ?? '').replace(/\/+$/, '')
  const speed = Number(arg('speed') ?? 1)
  if (![1, 2, 5].includes(speed)) throw new Error('--speed must be 1, 2 or 5')

  const extra = (process.env.TRAFFIC_REPLAY_SHARED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  let prod: string[]
  try {
    prod = await productionHosts()
  } catch (err) {
    throw new Error(
      `could not read the Environments registry to rule out production hosts (${(err as Error).message})`
    )
  }
  const refusal = socketReplayRefusal(target, {
    origin: capture.origin,
    refused: [config.PUBLIC_URL, config.ADMIN_URL, config.DB_HOST, ...prod, ...extra]
  })
  if (refusal) throw new Error(refusal)

  const full = has('full-scale')
  if (full && arg('confirm-dedicated') !== new URL(target).host)
    throw new Error(`--full-scale needs --confirm-dedicated ${new URL(target).host}`)
  const cap = full ? FULL_CLIENTS : SMOKE_CLIENTS
  const wanted = Number(arg('clients') ?? Math.min(cap, capture.connections.sockets || 50))
  if (!(wanted >= 1) || wanted > cap)
    throw new Error(`--clients must be 1–${cap}${full ? '' : ' (smoke scale; see --full-scale)'}`)

  const plan = planReplayClients(capture, wanted)
  const emits = planReplayEmits(capture, speed)
  const duration = emits.at(-1)?.at ?? 0
  const memberships = plan.reduce((s, c) => s + c.length, 0)
  console.log(
    `socket replay: ${capture.events.length} events captured on ${capture.origin ?? '?'} over ${Math.round(capture.window_ms / 1000)}s → ${target} at ×${speed} (${Math.round(duration / 1000)}s), ${wanted} clients, ${memberships} room joins`
  )
  if (has('dry-run')) {
    const byRoom = new Map<string, number>()
    for (const c of plan) for (const r of c) byRoom.set(r, (byRoom.get(r) ?? 0) + 1)
    for (const [r, n] of [...byRoom].sort((a, b) => b[1] - a[1]).slice(0, 15))
      console.log(`  ${n} client(s) in ${r}`)
  } else {
    const token = arg('token') ?? process.env.REALTIME_REPLAY_TOKEN ?? ''
    if (!token) throw new Error('--token is required (an administrator token valid on the target)')
    const api = async (path: string, init: RequestInit = {}) => {
      const res = await fetch(`${target}/api${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(init.headers ?? {})
        }
      })
      const text = await res.text()
      const body = text ? JSON.parse(text) : null
      if (!res.ok)
        throw new Error(
          `${init.method ?? 'GET'} ${path} → ${res.status} ${body?.error ?? text.slice(0, 200)}`
        )
      return body
    }
    const run = (
      await api('/realtime/replay/runs', {
        method: 'POST',
        body: JSON.stringify({ capture, speed })
      })
    ).data as { id: string; secret: string }

    const { io: connectSocket } = requireFrom('../../../admin/package.json')(
      'socket.io-client'
    ) as { io: (url: string, opts: Record<string, unknown>) => any }
    const latency: number[] = []
    let received = 0
    let expected = 0
    const members = new Map<string, number>()
    for (const c of plan) for (const r of c) members.set(r, (members.get(r) ?? 0) + 1)
    for (const e of emits) expected += members.get(e.room) ?? 0
    let connected = 0
    let failed = 0
    await Promise.all(
      plan.map(async (rooms, i) => {
        await sleep(i * 20)
        try {
          const ws = (await api('/auth/ws-token')).token as string
          const s = connectSocket(target, {
            transports: ['websocket'],
            reconnection: false,
            forceNew: true
          })
          sockets.push(s)
          let offset = 0
          s.on('nvr:ping', (p: unknown) => s.emit('nvr:pong', p))
          s.onAny((_event: string, payload: any) => {
            if (payload?._replay !== run.id || typeof payload._rs !== 'number') return
            received++
            const ms = Date.now() + offset - payload._rs
            if (ms >= 0 && ms < 120_000) latency.push(ms)
          })
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('no auth:ok in 15s')), 15_000)
            s.on('connect', () => {
              s.emit('client:hello', {
                app: 'socket-replay',
                transport: 'websocket',
                reconnects: 0
              })
              s.emit('auth', { token: ws })
            })
            s.on('auth:ok', () => {
              clearTimeout(t)
              resolve()
            })
            s.on('connect_error', (e: Error) => {
              clearTimeout(t)
              reject(e)
            })
          })
          // Server clock offset (#2132): the fastest of three round trips.
          let best: { rtt: number; off: number } | null = null
          for (let k = 0; k < 3; k++) {
            const sent = Date.now()
            const r = await new Promise<{ s?: number } | null>((res) => {
              const t = setTimeout(() => res(null), 3000)
              s.emit('time:sync', { c: sent }, (a: { s?: number }) => {
                clearTimeout(t)
                res(a)
              })
            })
            const back = Date.now()
            if (typeof r?.s === 'number' && (!best || back - sent < best.rtt))
              best = { rtt: back - sent, off: r.s - (sent + (back - sent) / 2) }
          }
          offset = best?.off ?? 0
          for (const room of rooms) s.emit('replay:join', { run: run.id, secret: run.secret, room })
          connected++
        } catch (err) {
          failed++
          if (failed <= 3) console.error(`  client ${i}: ${(err as Error).message}`)
        }
      })
    )
    await sleep(1500)
    console.log(`connected ${connected}/${plan.length}; replaying…`)
    await api(`/realtime/replay/runs/${run.id}/go`, {
      method: 'POST',
      body: JSON.stringify({ secret: run.secret })
    })
    await sleep(duration + 5000)
    const server = (
      await api(`/realtime/replay/runs/${run.id}/stop`, {
        method: 'POST',
        body: JSON.stringify({ secret: run.secret })
      })
    ).data
    const sorted = latency.sort((a, b) => a - b)
    const report = {
      at: new Date().toISOString(),
      target,
      capture: {
        origin: capture.origin,
        events: capture.events.length,
        window_ms: capture.window_ms
      },
      speed,
      clients: { planned: plan.length, connected, failed, room_joins: memberships },
      delivery: {
        expected,
        received,
        loss_pct: expected ? Math.round(((expected - received) / expected) * 1000) / 10 : null,
        latency_ms: {
          p50: pct(sorted, 0.5),
          p95: pct(sorted, 0.95),
          p99: pct(sorted, 0.99),
          max: pct(sorted, 1)
        }
      },
      server
    }
    console.log(
      `delivery ${received}/${expected} (loss ${report.delivery.loss_pct}%), p50 ${report.delivery.latency_ms.p50} / p95 ${report.delivery.latency_ms.p95} / p99 ${report.delivery.latency_ms.p99} ms`
    )
    console.log(
      `server   emitted ${server.emitted}/${server.planned}, API CPU ${server.api_cpu_pct ?? '—'}%, event loop p99 ${server.event_loop_ms?.p99 ?? '—'} ms, Redis ${server.redis ? `${server.redis.total_commands_processed} cmds, ${Math.round((server.redis.total_net_output_bytes ?? 0) / 1024)} KB out` : '—'}`
    )
    const out = arg('out')
    if (out) {
      writeFileSync(out, JSON.stringify(report, null, 2))
      console.log(`json → ${out}`)
    }
  }
} catch (err) {
  console.error(`socket replay refused: ${(err as Error).message}`)
  exitCode = 1
} finally {
  for (const s of sockets) {
    try {
      s.disconnect()
    } catch {
      /* gone */
    }
  }
  await db.destroy().catch(() => {})
}
process.exit(exitCode)
