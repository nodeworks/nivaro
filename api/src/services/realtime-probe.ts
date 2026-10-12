import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { flushJournal, journaledEmit, replaySince } from './event-journal.js'
import { getIo } from './io-holder.js'
import { tenantScopedRoom } from './tenant-rooms.js'

/**
 * Realtime delivery probe (#1682). A synthetic Socket.io client inside the
 * server connects to this process over the loopback interface (plain
 * WebSocket speaking the engine.io v4 framing — no client library), is put in
 * a private `probe:<uuid>` room, and a probe event is sent through the normal
 * emit path: sequence number, Redis journal, durable journal, and — when the
 * stream is on — out over the Redis stream and back in through this
 * replica's own reader, the path an event from another replica takes.
 *
 * It records how long the event took to arrive and whether it did, whether it
 * was journaled, and whether the durable row landed. The `realtime` ops
 * monitor type runs it every five minutes; slow or missing delivery fails the
 * monitor and raises an issue. The last results are kept in Redis so every
 * replica's Realtime console shows them.
 *
 * The probe socket never authenticates; it reads nothing but its own probe
 * event, and the zombie reaper would drop it after 45 seconds regardless.
 */

export interface ProbeResult {
  at: string
  ok: boolean
  arrived: boolean
  delivery_ms: number | null
  threshold_ms: number
  path: 'stream' | 'adapter' | 'none'
  journaled: boolean
  durable: boolean | null
  node: string | null
  detail: string
  /** True when the probe could not run here (no socket server listening) — not a failure. */
  skipped?: boolean
}

const RESULTS_KEY = 'nvr:rt:probe:results'
const RESULTS_KEEP = 50
export const DEFAULT_THRESHOLD_MS = 2000
const DEFAULT_TIMEOUT_MS = 10_000

let lastLocal: ProbeResult | null = null

/** engine.io v4 framing — exported for tests. */
export function parseEioFrame(
  raw: string
):
  | { kind: 'open' }
  | { kind: 'ping' }
  | { kind: 'connected'; sid: string | null }
  | { kind: 'event'; name: string; data: unknown }
  | { kind: 'other' } {
  if (raw.startsWith('0')) return { kind: 'open' }
  if (raw === '2') return { kind: 'ping' }
  if (raw.startsWith('40')) {
    try {
      const body = raw.slice(2)
      const parsed = body ? (JSON.parse(body) as { sid?: string }) : {}
      return { kind: 'connected', sid: parsed.sid ?? null }
    } catch {
      return { kind: 'connected', sid: null }
    }
  }
  if (raw.startsWith('42')) {
    try {
      const arr = JSON.parse(raw.slice(2)) as unknown[]
      if (Array.isArray(arr) && typeof arr[0] === 'string') {
        return { kind: 'event', name: arr[0], data: arr[1] }
      }
    } catch {
      /* not ours */
    }
  }
  return { kind: 'other' }
}

/** Ok/failing verdict — exported for tests. */
export function judgeProbe(
  arrived: boolean,
  deliveryMs: number | null,
  thresholdMs: number,
  journaled: boolean
): { ok: boolean; detail: string } {
  if (!arrived) return { ok: false, detail: 'Probe event never arrived' }
  const ms = deliveryMs ?? 0
  if (ms > thresholdMs)
    return { ok: false, detail: `Delivery took ${ms}ms (threshold ${thresholdMs}ms)` }
  if (!journaled)
    return {
      ok: false,
      detail: `Delivered in ${ms}ms but not journaled — clients that reconnect cannot catch up`
    }
  return { ok: true, detail: `Delivered in ${ms}ms` }
}

function listenPort(app: FastifyInstance): number | null {
  const addr = app.server.address() as AddressInfo | string | null
  if (!addr || typeof addr === 'string') return null
  return addr.port
}

export async function runRealtimeProbe(
  app: FastifyInstance,
  opts: { thresholdMs?: number; timeoutMs?: number } = {}
): Promise<ProbeResult> {
  const thresholdMs = Math.max(50, Number(opts.thresholdMs) || DEFAULT_THRESHOLD_MS)
  const timeoutMs = Math.max(1000, Math.min(60_000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS))
  const at = new Date().toISOString()
  const base = {
    at,
    threshold_ms: thresholdMs,
    node: null as string | null
  }
  try {
    const { INSTANCE_ID } = await import('./instance-roster.js')
    base.node = INSTANCE_ID
  } catch {
    /* label only */
  }
  const io = getIo()
  const port = listenPort(app)
  if (!io || !port) {
    return record(app, {
      ...base,
      ok: false,
      arrived: false,
      delivery_ms: null,
      path: 'none',
      journaled: false,
      durable: null,
      detail: 'Socket server not listening in this process',
      skipped: true
    })
  }

  const probeId = randomUUID()
  const roomName = `probe:${probeId}`
  // The room journaledEmit will target (tenant-prefixed when run inside a tenant).
  const room = tenantScopedRoom(roomName)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`)
  let sid: string | null = null
  let sentAt = 0
  let arrivedAt: number | null = null

  const outcome = await new Promise<{
    path: ProbeResult['path']
    seq: number | null
    err?: string
  }>((resolve) => {
    let emitted: { path: ProbeResult['path']; seq: number | null } = { path: 'none', seq: null }
    const timer = setTimeout(() => resolve({ ...emitted, err: 'timeout' }), timeoutMs)
    ws.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ...emitted, err: err instanceof Error ? err.message : String(err) })
    })
    ws.on('message', (data) => {
      const f = parseEioFrame(String(data))
      if (f.kind === 'open') ws.send('40')
      else if (f.kind === 'ping') ws.send('3')
      else if (f.kind === 'connected' && f.sid && !sid) {
        sid = f.sid
        io.in(sid).socketsJoin(room)
        sentAt = Date.now()
        void journaledEmit(
          room,
          'realtime:probe',
          { probe: probeId },
          { selfViaStream: true, roomScoped: true }
        ).then((r) => {
          emitted = { path: r.path, seq: r.seq }
        })
      } else if (f.kind === 'event' && f.name === 'realtime:probe') {
        const d = f.data as { probe?: string } | null
        if (d?.probe === probeId) {
          arrivedAt = Date.now()
          clearTimeout(timer)
          // The emit promise resolves before (or right after) delivery.
          setTimeout(() => resolve(emitted), 50)
        }
      }
    })
  })
  try {
    ws.close()
  } catch {
    /* already gone */
  }

  const arrived = arrivedAt != null
  const deliveryMs = arrivedAt != null ? arrivedAt - sentAt : null
  let journaled = false
  let durable: boolean | null = null
  if (outcome.seq != null) {
    try {
      const replay = await replaySince(outcome.seq - 1, new Set([room]))
      journaled = replay.events.some((e) => e.seq === outcome.seq)
    } catch {
      journaled = false
    }
    try {
      if (await hasColumn('nivaro_event_journal', 'seq')) {
        await flushJournal()
        const row = await db('nivaro_event_journal').where({ seq: outcome.seq, room }).first('id')
        durable = !!row
      }
    } catch {
      durable = false
    }
  }
  const verdict = judgeProbe(arrived, deliveryMs, thresholdMs, journaled)
  let detail = verdict.detail
  if (outcome.err && !arrived) detail = `${detail} (${outcome.err})`
  if (arrived) detail += ` via ${outcome.path === 'stream' ? 'the Redis stream' : 'pub/sub'}`
  if (durable === false) detail += ' · durable journal row missing'
  return record(app, {
    ...base,
    ok: verdict.ok,
    arrived,
    delivery_ms: deliveryMs,
    path: outcome.path,
    journaled,
    durable,
    detail
  })
}

async function record(app: FastifyInstance, r: ProbeResult): Promise<ProbeResult> {
  lastLocal = r
  try {
    const redis = (app as unknown as { redis?: import('ioredis').Redis }).redis
    if (redis) {
      await redis
        .multi()
        .lpush(RESULTS_KEY, JSON.stringify(r))
        .ltrim(RESULTS_KEY, 0, RESULTS_KEEP - 1)
        .exec()
    }
  } catch {
    /* the in-process copy still answers */
  }
  return r
}

/** Newest results first (all replicas, via Redis; this process's last as a fallback). */
export async function recentProbeResults(app: FastifyInstance, limit = 20): Promise<ProbeResult[]> {
  try {
    const redis = (app as unknown as { redis?: import('ioredis').Redis }).redis
    if (redis) {
      const raw = await redis.lrange(RESULTS_KEY, 0, Math.max(0, limit - 1))
      const out: ProbeResult[] = []
      for (const s of raw) {
        try {
          out.push(JSON.parse(s) as ProbeResult)
        } catch {
          /* skip */
        }
      }
      if (out.length) return out
    }
  } catch {
    /* fall through */
  }
  return lastLocal ? [lastLocal] : []
}
